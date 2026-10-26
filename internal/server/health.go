package server

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Saúde: junta o que costuma dar problema num homelab (disco morrendo, pool
// degradado, serviço do PVE parado, atualização pendente, certificado
// vencendo, storage cheio, guest sem backup) numa lista de checagens.

type check struct {
	Level  string `json:"level"` // crit | warn | ok
	Area   string `json:"area"`  // discos | zfs | serviços | atualizações | certificados | storage | nós | backups | cluster
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	Node   string `json:"node,omitempty"`
}

type diskHealth struct {
	Node    string  `json:"node"`
	Dev     string  `json:"dev"`
	Model   string  `json:"model"`
	Type    string  `json:"type"`
	Size    pve.Int `json:"size"`
	Health  string  `json:"health"`
	Wearout int     `json:"wearout"` // % já gasto (-1 = sem dado)
	Used    string  `json:"used"`
}

type serviceHealth struct {
	Node  string `json:"node"`
	Name  string `json:"name"`
	State string `json:"state"`
	Desc  string `json:"desc"`
}

type updatesHealth struct {
	Node     string   `json:"node"`
	Count    int      `json:"count"`
	Packages []string `json:"packages"`
}

type certHealth struct {
	Node     string  `json:"node"`
	File     string  `json:"file"`
	Subject  string  `json:"subject"`
	NotAfter pve.Int `json:"notAfter"`
}

type healthReport struct {
	Checks   []check         `json:"checks"`
	Disks    []diskHealth    `json:"disks"`
	Services []serviceHealth `json:"services"`
	Updates  []updatesHealth `json:"updates"`
	Certs    []certHealth    `json:"certs"`
	At       int64           `json:"at"`
}

// Serviços que importam; os de "crit" derrubam o painel/cluster se pararem.
var watchedServices = map[string]string{
	"pveproxy": "crit", "pvedaemon": "crit", "pve-cluster": "crit", "corosync": "crit",
	"pvestatd": "warn", "pve-firewall": "warn", "pvescheduler": "warn", "chrony": "warn", "cron": "warn",
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	rep, err := cached(s.cache, a.User, "health", 60*time.Second, func() (*healthReport, error) {
		return s.buildHealth(r.Context(), a)
	})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, rep)
}

func (s *Server) buildHealth(ctx context.Context, a pve.Auth) (*healthReport, error) {
	res, err := s.resources(ctx, a)
	if err != nil {
		return nil, err
	}
	rep := &healthReport{Checks: []check{}, Disks: []diskHealth{}, Services: []serviceHealth{}, Updates: []updatesHealth{}, Certs: []certHealth{}, At: time.Now().Unix()}
	var mu sync.Mutex
	add := func(c check) {
		mu.Lock()
		rep.Checks = append(rep.Checks, c)
		mu.Unlock()
	}

	// Cluster e nós (dados que já temos).
	cv := s.cluster(ctx, a, res)
	if !cv.Standalone && !cv.Quorate {
		add(check{Level: "crit", Area: "cluster", Title: "Cluster sem quórum", Detail: fmt.Sprintf("%d de %d nós online; o cluster fica só leitura", cv.NodesOnline, cv.Nodes)})
	}
	var online []string
	sharedSeen := map[string]bool{}
	for _, r := range res {
		switch r.Type {
		case "node":
			if r.Status != "online" {
				add(check{Level: "crit", Area: "nós", Node: r.Node, Title: "Nó " + r.Node + " offline"})
				continue
			}
			online = append(online, r.Node)
			if r.MaxMem > 0 && float64(r.Mem)/float64(r.MaxMem) >= 0.9 {
				add(check{Level: "warn", Area: "nós", Node: r.Node, Title: "Memória quase cheia em " + r.Node, Detail: pctStr(r.Mem, r.MaxMem) + " em uso"})
			}
			if r.MaxDisk > 0 && float64(r.Disk)/float64(r.MaxDisk) >= 0.85 {
				add(check{Level: "warn", Area: "nós", Node: r.Node, Title: "Disco do sistema enchendo em " + r.Node, Detail: pctStr(r.Disk, r.MaxDisk) + " do / usado"})
			}
		case "storage":
			if r.Shared {
				if sharedSeen[r.Storage] {
					continue
				}
				sharedSeen[r.Storage] = true
			}
			if r.MaxDisk == 0 || r.Status != "available" {
				continue
			}
			f := float64(r.Disk) / float64(r.MaxDisk)
			lvl := ""
			switch {
			case f >= 0.95:
				lvl = "crit"
			case f >= 0.85:
				lvl = "warn"
			}
			if lvl != "" {
				where := r.Node
				if r.Shared {
					where = "compartilhado"
				}
				add(check{Level: lvl, Area: "storage", Node: r.Node, Title: "Storage " + r.Storage + " quase cheio", Detail: pctStr(r.Disk, r.MaxDisk) + " usado (" + where + ")"})
			}
		}
	}
	slices.Sort(online)

	var wg sync.WaitGroup
	for _, n := range online {
		wg.Add(4)
		go func() {
			defer wg.Done()
			var disks []struct {
				DevPath string  `json:"devpath"`
				Model   string  `json:"model"`
				Type    string  `json:"type"`
				Size    pve.Int `json:"size"`
				Health  string  `json:"health"`
				Wearout pve.Num `json:"wearout"`
				Used    string  `json:"used"`
			}
			if s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(n)+"/disks/list", nil, &disks) != nil {
				return
			}
			for _, d := range disks {
				// O PVE devolve a vida restante; aqui vira % gasto.
				worn := -1
				if d.Wearout > 0 && d.Type != "hdd" {
					worn = 100 - int(d.Wearout)
				}
				mu.Lock()
				rep.Disks = append(rep.Disks, diskHealth{Node: n, Dev: d.DevPath, Model: d.Model, Type: d.Type, Size: d.Size, Health: d.Health, Wearout: worn, Used: d.Used})
				mu.Unlock()
				h := strings.ToUpper(d.Health)
				if h != "" && h != "PASSED" && h != "OK" && h != "UNKNOWN" {
					add(check{Level: "crit", Area: "discos", Node: n, Title: "SMART falhou em " + d.DevPath, Detail: d.Model + " · " + d.Health})
				}
				if worn >= 90 {
					add(check{Level: "crit", Area: "discos", Node: n, Title: "SSD no fim da vida: " + d.DevPath, Detail: fmt.Sprintf("%s · %d%% gasto", d.Model, worn)})
				} else if worn >= 80 {
					add(check{Level: "warn", Area: "discos", Node: n, Title: "SSD desgastado: " + d.DevPath, Detail: fmt.Sprintf("%s · %d%% gasto", d.Model, worn)})
				}
			}
		}()
		go func() {
			defer wg.Done()
			pools, err := s.pve.ZFSPools(ctx, &a, n)
			if err != nil {
				return
			}
			for _, p := range pools {
				if p.Health != "" && p.Health != "ONLINE" {
					add(check{Level: "crit", Area: "zfs", Node: n, Title: "Pool ZFS " + p.Name + " " + p.Health, Detail: "em " + n + "; veja zpool status no shell"})
				}
			}
		}()
		go func() {
			defer wg.Done()
			var svcs []struct {
				Name      string `json:"name"`
				Service   string `json:"service"`
				State     string `json:"state"`
				UnitState string `json:"unit-state"`
				Desc      string `json:"desc"`
			}
			if s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(n)+"/services", nil, &svcs) != nil {
				return
			}
			for _, sv := range svcs {
				name := cmp.Or(sv.Service, sv.Name)
				lvl, watched := watchedServices[name]
				if !watched {
					continue
				}
				if name == "corosync" && cv.Standalone {
					continue
				}
				mu.Lock()
				rep.Services = append(rep.Services, serviceHealth{Node: n, Name: name, State: sv.State, Desc: sv.Desc})
				mu.Unlock()
				if sv.State != "running" && sv.UnitState != "disabled" {
					add(check{Level: lvl, Area: "serviços", Node: n, Title: name + " parado em " + n, Detail: sv.Desc})
				}
			}
		}()
		go func() {
			defer wg.Done()
			var ups []struct {
				Package string `json:"Package"`
			}
			if s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(n)+"/apt/update", nil, &ups) == nil && len(ups) > 0 {
				names := []string{}
				for _, u := range ups {
					names = append(names, u.Package)
				}
				slices.Sort(names)
				mu.Lock()
				rep.Updates = append(rep.Updates, updatesHealth{Node: n, Count: len(ups), Packages: names})
				mu.Unlock()
				lvl := "warn"
				detail := fmt.Sprintf("%d pacotes", len(ups))
				if slices.ContainsFunc(names, func(p string) bool { return strings.HasPrefix(p, "proxmox-kernel") || p == "pve-manager" }) {
					detail += ", inclui pve-manager/kernel"
				}
				add(check{Level: lvl, Area: "atualizações", Node: n, Title: "Atualizações pendentes em " + n, Detail: detail})
			}
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			var certs []struct {
				Filename string  `json:"filename"`
				Subject  string  `json:"subject"`
				NotAfter pve.Int `json:"notafter"`
			}
			if s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(n)+"/certificates/info", nil, &certs) != nil {
				return
			}
			for _, c := range certs {
				if c.Filename == "pve-root-ca.pem" {
					continue
				}
				mu.Lock()
				rep.Certs = append(rep.Certs, certHealth{Node: n, File: c.Filename, Subject: c.Subject, NotAfter: c.NotAfter})
				mu.Unlock()
				left := time.Until(time.Unix(int64(c.NotAfter), 0))
				switch {
				case left < 0:
					add(check{Level: "crit", Area: "certificados", Node: n, Title: "Certificado vencido em " + n, Detail: c.Filename})
				case left < 21*24*time.Hour:
					add(check{Level: "warn", Area: "certificados", Node: n, Title: "Certificado vence em breve em " + n, Detail: fmt.Sprintf("%s · %d dias", c.Filename, int(left.Hours()/24))})
				}
			}
		}()
	}

	// Guests que nenhum job de backup cobre.
	wg.Add(1)
	go func() {
		defer wg.Done()
		var nb []struct {
			VMID pve.Num `json:"vmid"`
			Name string  `json:"name"`
			Type string  `json:"type"`
		}
		if s.pve.Get(ctx, &a, "/cluster/backup-info/not-backed-up", nil, &nb) != nil || len(nb) == 0 {
			return
		}
		names := []string{}
		for _, g := range nb {
			names = append(names, fmt.Sprintf("%s (%d)", g.Name, int(g.VMID)))
		}
		slices.Sort(names)
		add(check{Level: "warn", Area: "backups", Title: fmt.Sprintf("%d guests sem job de backup", len(nb)), Detail: strings.Join(names, ", ")})
	}()
	wg.Wait()

	rank := map[string]int{"crit": 0, "warn": 1, "ok": 2}
	slices.SortFunc(rep.Checks, func(x, y check) int {
		return cmp.Or(cmp.Compare(rank[x.Level], rank[y.Level]), cmp.Compare(x.Area, y.Area), cmp.Compare(x.Title, y.Title))
	})
	slices.SortFunc(rep.Disks, func(x, y diskHealth) int { return cmp.Or(cmp.Compare(x.Node, y.Node), cmp.Compare(x.Dev, y.Dev)) })
	slices.SortFunc(rep.Services, func(x, y serviceHealth) int { return cmp.Or(cmp.Compare(x.Node, y.Node), cmp.Compare(x.Name, y.Name)) })
	slices.SortFunc(rep.Updates, func(x, y updatesHealth) int { return cmp.Compare(x.Node, y.Node) })
	slices.SortFunc(rep.Certs, func(x, y certHealth) int { return cmp.Or(cmp.Compare(x.Node, y.Node), cmp.Compare(x.File, y.File)) })
	return rep, nil
}

func pctStr(used, total int64) string {
	return fmt.Sprintf("%.0f%%", float64(used)/float64(total)*100)
}

// handleAptRefresh roda "apt update" no nó (vira task) pra atualizar a lista.
func (s *Server) handleAptRefresh(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var upid string
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/apt/update", nil, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

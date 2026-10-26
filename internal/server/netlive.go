package server

import (
	"cmp"
	"context"
	"hash/fnv"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Rede ao vivo: estado das portas físicas (link, velocidade) e tráfego por
// interface e por guest, pro painel de portas e pro mapa da topologia.

// rateMeter transforma contadores de bytes em bytes/s, comparando com a
// leitura anterior do mesmo contador.
type rateMeter struct {
	mu   sync.Mutex
	last map[string]rateSample
}

type rateSample struct {
	at        time.Time
	in, out   int64
	rin, rout float64
	ok        bool
}

// rate devolve a taxa desde a última leitura. Na primeira (ou se o contador
// zerou) não tem como saber: ok=false. hold é por quanto tempo um contador
// parado ainda repete a última taxa: o PVE só atualiza o netin/netout dos
// guests a cada ~10s, então leitura no meio não quer dizer tráfego zero.
func (m *rateMeter) rate(key string, in, out int64, now time.Time, hold time.Duration) (float64, float64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last == nil {
		m.last = map[string]rateSample{}
	}
	p, seen := m.last[key]
	age := now.Sub(p.at)
	if seen && (age < 2*time.Second || (in == p.in && out == p.out && age < hold)) {
		return p.rin, p.rout, p.ok
	}
	s := rateSample{at: now, in: in, out: out}
	if seen && in >= p.in && out >= p.out {
		dt := age.Seconds()
		s.rin, s.rout, s.ok = float64(in-p.in)/dt, float64(out-p.out)/dt, true
	}
	m.last[key] = s
	return s.rin, s.rout, s.ok
}

type linkInfo struct {
	Up     bool     `json:"up"`
	Speed  int      `json:"speed"` // Mb/s; 0 = desconhecida
	Duplex string   `json:"duplex,omitempty"`
	MAC    string   `json:"mac,omitempty"`
	Rx     *float64 `json:"rx"` // bytes/s; null até a segunda leitura
	Tx     *float64 `json:"tx"`
}

var sysNet = "/sys/class/net"

func readLink(name string) (li linkInfo, rx, tx int64, ok bool) {
	dir := filepath.Join(sysNet, name)
	if _, err := os.Stat(dir); err != nil {
		return li, 0, 0, false
	}
	rd := func(f string) string {
		b, _ := os.ReadFile(filepath.Join(dir, f))
		return strings.TrimSpace(string(b))
	}
	li.MAC, li.Duplex = rd("address"), rd("duplex")
	st := rd("operstate")
	li.Up = st == "up" || (st == "unknown" && rd("carrier") == "1")
	if n, err := strconv.Atoi(rd("speed")); err == nil && n > 0 {
		li.Speed = n
	}
	rx, _ = strconv.ParseInt(rd("statistics/rx_bytes"), 10, 64)
	tx, _ = strconv.ParseInt(rd("statistics/tx_bytes"), 10, 64)
	return li, rx, tx, true
}

// isLocalNode: o Mia roda num dos nós; só desse dá pra ler o /sys.
func isLocalNode(node string) bool {
	h, err := os.Hostname()
	if err != nil {
		return false
	}
	short, _, _ := strings.Cut(h, ".")
	return strings.EqualFold(short, node)
}

// links lê o estado das interfaces do nó. Fora do nó local devolve nil e a
// tela fica só com o "ativa" do PVE.
func (s *Server) links(node string, names []string) map[string]linkInfo {
	if s.cfg.Demo {
		return demoLinks(node, names)
	}
	if !isLocalNode(node) {
		return nil
	}
	out := map[string]linkInfo{}
	now := time.Now()
	for _, n := range names {
		li, rx, tx, ok := readLink(n)
		if !ok {
			continue
		}
		if in, o, ok := s.meter.rate("if:"+n, rx, tx, now, 0); ok {
			li.Rx, li.Tx = &in, &o
		}
		out[n] = li
	}
	return out
}

// demoLinks inventa portas plausíveis: uma desplugada, velocidades variadas
// e tráfego que oscila devagar.
func demoLinks(node string, names []string) map[string]linkInfo {
	speeds := map[string]int{"enp5s0": 2500, "enp6s0": 1000, "enp7s0": 1000, "enp8s0": 10000}
	t := float64(time.Now().Unix())
	out := map[string]linkInfo{}
	for _, n := range names {
		h := fnv.New32a()
		h.Write([]byte(node + n))
		seed := float64(h.Sum32()%1000) / 1000
		li := linkInfo{Up: true, MAC: "bc:24:11:" + strconv.FormatUint(uint64(h.Sum32()%256), 16) + ":4e:0" + strconv.Itoa(len(n)%10), Duplex: "full"}
		if strings.HasPrefix(n, "enp") {
			li.Speed = speeds[n]
		}
		if n == "enp7s0" || (node != "pve-01" && n == "enp6s0") {
			li.Up, li.Speed, li.Duplex = false, 0, ""
		}
		if li.Up {
			base := 2e5 + seed*4e6
			if strings.HasSuffix(n, "8s0") || n == "vmbr2" {
				base *= 6
			}
			rx := base * (1 + 0.6*math.Sin(t/23+seed*7))
			tx := base * 0.35 * (1 + 0.6*math.Cos(t/31+seed*5))
			li.Rx, li.Tx = &rx, &tx
		} else {
			zero := 0.0
			li.Rx, li.Tx = &zero, &zero
		}
		out[n] = li
	}
	return out
}

// ---------- topologia ----------

type topoNIC struct {
	Key      string `json:"key"`
	Bridge   string `json:"bridge"`
	Tag      string `json:"tag,omitempty"`
	MAC      string `json:"mac,omitempty"`
	IP       string `json:"ip,omitempty"` // só LXC: o ip= da placa
	Firewall bool   `json:"firewall"`
	Down     bool   `json:"down"` // link_down=1
}

type topoGuest struct {
	ID     string    `json:"id"`
	VMID   int       `json:"vmid"`
	Type   string    `json:"type"`
	Name   string    `json:"name"`
	Status string    `json:"status"`
	IP     string    `json:"ip"`
	NICs   []topoNIC `json:"nics"`
	Rx     *float64  `json:"rx"`
	Tx     *float64  `json:"tx"`
}

var nicModels = []string{"virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"}

func parseNIC(key, val string) topoNIC {
	o := parseKV(val)
	n := topoNIC{Key: key, Bridge: o.vals["bridge"], Tag: o.vals["tag"], MAC: o.vals["hwaddr"],
		Firewall: o.vals["firewall"] == "1", Down: o.vals["link_down"] == "1"}
	for _, m := range nicModels {
		if v := o.vals[m]; v != "" {
			n.MAC = v
		}
	}
	if ip, _, _ := strings.Cut(o.vals["ip"], "/"); ip != "dhcp" && ip != "manual" {
		n.IP = ip
	}
	return n
}

// handleTopology: guests do nó com as placas (bridge, VLAN), IP e tráfego.
func (s *Server) handleTopology(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node := r.PathValue("node")
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		sem = make(chan struct{}, 8)
		out = []topoGuest{}
		now = time.Now()
	)
	for _, g := range res {
		if !g.IsGuest() || bool(g.Template) || g.Node != node {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			t := s.topoGuest(r.Context(), a, g, now)
			mu.Lock()
			out = append(out, t)
			mu.Unlock()
		}()
	}
	wg.Wait()
	slices.SortFunc(out, func(x, y topoGuest) int { return x.VMID - y.VMID })
	writeJSON(w, map[string]any{"guests": out})
}

func (s *Server) topoGuest(ctx context.Context, a pve.Auth, g pve.Resource, now time.Time) topoGuest {
	t := topoGuest{ID: g.ID, VMID: g.VMID, Type: g.Type, Name: g.Name, Status: g.Status, NICs: []topoNIC{}}
	cfg, _ := cached(s.cache, a.User, "cfg:"+g.ID, 30*time.Second, func() (map[string]string, error) {
		return s.rawConfig(ctx, a, g)
	})
	for k, v := range cfg {
		if n, ok := strings.CutPrefix(k, "net"); ok {
			if _, err := strconv.Atoi(n); err == nil {
				t.NICs = append(t.NICs, parseNIC(k, v))
			}
		}
	}
	idx := func(n topoNIC) int { i, _ := strconv.Atoi(n.Key[3:]); return i }
	slices.SortFunc(t.NICs, func(x, y topoNIC) int { return cmp.Compare(idx(x), idx(y)) })
	if g.Status == "running" {
		ips, _ := cached(s.cache, a.User, "ip:"+g.ID, time.Minute, func() (guestIPs, error) {
			return s.guestIP(ctx, a, g), nil
		})
		t.IP = ips.lan
		if in, o, ok := s.meter.rate("g:"+g.ID, int64(g.NetIn), int64(g.NetOut), now, 25*time.Second); ok {
			t.Rx, t.Tx = &in, &o
		}
	}
	if t.IP == "" && len(t.NICs) > 0 {
		t.IP = t.NICs[0].IP
	}
	return t
}

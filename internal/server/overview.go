package server

import (
	"cmp"
	"context"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

type guestView struct {
	ID       string   `json:"id"` // "lxc/103"
	VMID     int      `json:"vmid"`
	Name     string   `json:"name"`
	Type     string   `json:"type"` // qemu | lxc
	Node     string   `json:"node"`
	Status   string   `json:"status"`
	CPU      float64  `json:"cpu"` // % da alocação
	MaxCPU   float64  `json:"maxcpu"`
	Mem      int64    `json:"mem"`
	MaxMem   int64    `json:"maxmem"`
	Disk     int64    `json:"disk"`
	MaxDisk  int64    `json:"maxdisk"`
	Uptime   int64    `json:"uptime"`
	Template bool     `json:"template"`
	Tags     []string `json:"tags"`
	Lock     string   `json:"lock,omitempty"`
	HAState  string   `json:"hastate,omitempty"`
}

func toGuest(r pve.Resource) guestView {
	tags := []string{}
	for t := range strings.FieldsFuncSeq(r.Tags, func(c rune) bool { return c == ';' || c == ',' || c == ' ' }) {
		tags = append(tags, t)
	}
	return guestView{
		ID: r.ID, VMID: r.VMID, Name: r.Name, Type: r.Type, Node: r.Node, Status: r.Status,
		CPU: round1(r.CPU * 100), MaxCPU: r.MaxCPU, Mem: r.Mem, MaxMem: r.MaxMem,
		Disk: r.Disk, MaxDisk: r.MaxDisk, Uptime: r.Uptime, Template: bool(r.Template),
		Tags: tags, Lock: r.Lock, HAState: r.HAState,
	}
}

type nodeView struct {
	Name   string  `json:"name"`
	Online bool    `json:"online"`
	IP     string  `json:"ip,omitempty"`
	CPU    float64 `json:"cpu"`
	MaxCPU float64 `json:"maxcpu"`
	Mem    int64   `json:"mem"`
	MaxMem int64   `json:"maxmem"`
	Uptime int64   `json:"uptime"`
}

type clusterView struct {
	Name        string `json:"name"`
	Nodes       int    `json:"nodes"`
	NodesOnline int    `json:"nodesOnline"`
	Quorate     bool   `json:"quorate"`
	Standalone  bool   `json:"standalone"`
	PVEVersion  string `json:"pveVersion"`
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

func (s *Server) resources(ctx context.Context, a pve.Auth) ([]pve.Resource, error) {
	return cached(s.cache, a.User, "resources", 4*time.Second, func() ([]pve.Resource, error) {
		return s.pve.Resources(ctx, &a)
	})
}

func (s *Server) clusterStatus(ctx context.Context, a pve.Auth) ([]pve.ClusterStatus, error) {
	return cached(s.cache, a.User, "cluster", 15*time.Second, func() ([]pve.ClusterStatus, error) {
		return s.pve.ClusterStatus(ctx, &a)
	})
}

func (s *Server) onlineNodes(ctx context.Context, a pve.Auth) ([]string, error) {
	res, err := s.resources(ctx, a)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, r := range res {
		if r.Type == "node" && r.Status == "online" {
			out = append(out, r.Node)
		}
	}
	slices.Sort(out)
	return out, nil
}

func (s *Server) cluster(ctx context.Context, a pve.Auth, res []pve.Resource) clusterView {
	cv := clusterView{Quorate: true, Standalone: true}
	if st, err := s.clusterStatus(ctx, a); err == nil {
		for _, row := range st {
			if row.Type == "cluster" {
				cv.Name, cv.Quorate, cv.Standalone = row.Name, bool(row.Quorate), false
			}
		}
	}
	for _, r := range res {
		if r.Type == "node" {
			cv.Nodes++
			if r.Status == "online" {
				cv.NodesOnline++
			}
			if cv.Name == "" {
				cv.Name = r.Node
			}
		}
	}
	if v, err := cached(s.cache, a.User, "version", 5*time.Minute, func() (pve.Version, error) {
		return s.pve.Version(ctx, &a)
	}); err == nil {
		cv.PVEVersion = v.Version
	}
	return cv
}

func (s *Server) nodeIPs(ctx context.Context, a pve.Auth) map[string]string {
	ips := map[string]string{}
	if st, err := s.clusterStatus(ctx, a); err == nil {
		for _, row := range st {
			if row.Type == "node" {
				ips[row.Name] = row.IP
			}
		}
	}
	return ips
}

// --- /api/status ---

// handleStatus é o resumo leve que a barra lateral consulta em toda tela.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	ips := s.nodeIPs(r.Context(), a)
	nodes := []nodeView{}
	for _, n := range res {
		if n.Type == "node" {
			nodes = append(nodes, nodeView{Name: n.Node, Online: n.Status == "online", IP: ips[n.Node],
				CPU: round1(n.CPU * 100), MaxCPU: n.MaxCPU, Mem: n.Mem, MaxMem: n.MaxMem, Uptime: n.Uptime})
		}
	}
	slices.SortFunc(nodes, func(x, y nodeView) int { return cmp.Compare(x.Name, y.Name) })
	writeJSON(w, map[string]any{
		"cluster":   s.cluster(r.Context(), a, res),
		"tailscale": s.ts.status(r.Context()),
		"nodes":     nodes,
	})
}

// --- /api/overview ---

type rangeSpec struct {
	window time.Duration
	tf     string // timeframe do rrd que cobre a janela
	prevTF string // timeframe que cobre duas janelas (pra comparar)
}

var ranges = map[string]rangeSpec{
	"24h": {24 * time.Hour, "day", "week"},
	"7d":  {7 * 24 * time.Hour, "week", "month"},
	"30d": {30 * 24 * time.Hour, "month", "year"},
}

type guestSamples struct {
	ID   string    `json:"id"`
	T    []int64   `json:"t"`
	CPU  []float64 `json:"cpu"` // % da alocação
	Mem  []int64   `json:"mem"`
	Name string    `json:"name"`
}

type trendView struct {
	T       []int64    `json:"t"`
	CPU     []float64  `json:"cpu"`
	RAM     []float64  `json:"ram"`
	Backups [][2]int64 `json:"backups"`
	Peak    *peakView  `json:"peak"`
}

type peakView struct {
	T     int64    `json:"t"`
	CPU   float64  `json:"cpu"`
	Delta float64  `json:"delta"` // pontos acima da média
	Top   []string `json:"top"`   // guests que mais pesaram no pico
}

type loadView struct {
	Avg          float64  `json:"avg"`
	Now          float64  `json:"now"`
	Delta        *float64 `json:"delta"` // % vs janela anterior
	GuestsActive int      `json:"guestsActive"`
}

type overview struct {
	Range     string         `json:"range"`
	From      int64          `json:"from"`
	To        int64          `json:"to"`
	Cluster   clusterView    `json:"cluster"`
	Tailscale string         `json:"tailscale"`
	Load      loadView       `json:"load"`
	Samples   []guestSamples `json:"samples"`
	Trend     trendView      `json:"trend"`
	Guests    []guestView    `json:"guests"`
	Nodes     []nodeView     `json:"nodes"`
	Warnings  []string       `json:"warnings"`
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	key := r.URL.Query().Get("range")
	spec, ok := ranges[key]
	if !ok {
		key, spec = "24h", ranges["24h"]
	}
	ov, err := cached(s.cache, a.User, "overview:"+key, 15*time.Second, func() (*overview, error) {
		return s.buildOverview(r.Context(), a, key, spec)
	})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	ov.Tailscale = s.ts.status(r.Context())
	writeJSON(w, ov)
}

func (s *Server) buildOverview(ctx context.Context, a pve.Auth, key string, spec rangeSpec) (*overview, error) {
	res, err := s.resources(ctx, a)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	from := now.Add(-spec.window).Unix()
	prevFrom := now.Add(-2 * spec.window).Unix()

	ov := &overview{Range: key, From: from, To: now.Unix(), Cluster: s.cluster(ctx, a, res),
		Samples: []guestSamples{}, Guests: []guestView{}, Nodes: []nodeView{}, Warnings: []string{}}

	ips := s.nodeIPs(ctx, a)
	var nodes []pve.Resource
	var running []pve.Resource
	for _, r := range res {
		switch {
		case r.Type == "node":
			ov.Nodes = append(ov.Nodes, nodeView{Name: r.Node, Online: r.Status == "online", IP: ips[r.Node],
				CPU: round1(r.CPU * 100), MaxCPU: r.MaxCPU, Mem: r.Mem, MaxMem: r.MaxMem, Uptime: r.Uptime})
			if r.Status == "online" {
				nodes = append(nodes, r)
			}
		case r.IsGuest():
			ov.Guests = append(ov.Guests, toGuest(r))
			if r.Status == "running" && !r.Template {
				running = append(running, r)
			}
		}
	}
	slices.SortFunc(ov.Nodes, func(x, y nodeView) int { return cmp.Compare(x.Name, y.Name) })
	slices.SortFunc(ov.Guests, func(x, y guestView) int { return x.VMID - y.VMID })
	ov.Load.GuestsActive = len(running)

	// Busca tudo em paralelo, com teto pra não afogar o pveproxy.
	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		sem      = make(chan struct{}, 8)
		nodeRRD  = map[string][]pve.RRDPoint{}
		nodePrev = map[string][]pve.RRDPoint{}
		guestRRD = map[string][]pve.RRDPoint{}
		tasks    []pve.Task
		failed   = map[string]int{}
	)
	run := func(label string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := fn(); err != nil {
				mu.Lock()
				failed[label]++
				mu.Unlock()
			}
		}()
	}
	for _, n := range nodes {
		run("rrd dos nós", func() error {
			pts, err := s.pve.NodeRRD(ctx, &a, n.Node, spec.tf)
			mu.Lock()
			nodeRRD[n.Node] = pts
			mu.Unlock()
			return err
		})
		run("comparativo", func() error {
			pts, err := s.pve.NodeRRD(ctx, &a, n.Node, spec.prevTF)
			mu.Lock()
			nodePrev[n.Node] = pts
			mu.Unlock()
			return err
		})
		run("tasks de backup", func() error {
			t, err := s.pve.NodeTasks(ctx, &a, n.Node, "vzdump", from)
			mu.Lock()
			tasks = append(tasks, t...)
			mu.Unlock()
			return err
		})
	}
	for _, g := range running {
		run("rrd dos guests", func() error {
			pts, err := s.pve.GuestRRD(ctx, &a, g.Node, g.Type, g.VMID, spec.tf)
			mu.Lock()
			guestRRD[g.ID] = pts
			mu.Unlock()
			return err
		})
	}
	wg.Wait()
	for label, n := range failed {
		ov.Warnings = append(ov.Warnings, "falhou ao buscar "+label+" ("+strconv.Itoa(n)+")")
	}
	slices.Sort(ov.Warnings)

	// Carga agora: média ponderada pelos núcleos de cada nó.
	var used, total float64
	for _, n := range nodes {
		used += n.CPU * n.MaxCPU
		total += n.MaxCPU
	}
	if total > 0 {
		ov.Load.Now = round1(used / total * 100)
	}

	ov.Trend = aggregateNodes(nodeRRD, from, now.Unix())
	ov.Trend.Backups = backupWindows(tasks, from, now.Unix())
	ov.Load.Avg = round1(mean(ov.Trend.CPU))

	prev := aggregateNodes(nodePrev, prevFrom, now.Unix())
	var before, after []float64
	for i, t := range prev.T {
		if t < from {
			before = append(before, prev.CPU[i])
		} else {
			after = append(after, prev.CPU[i])
		}
	}
	if b := mean(before); len(before) > 0 && len(after) > 0 && b > 0 {
		d := round1((mean(after) - b) / b * 100)
		ov.Load.Delta = &d
	}

	names := map[string]string{}
	for _, g := range running {
		names[g.ID] = g.Name
		pts := guestRRD[g.ID]
		gs := guestSamples{ID: g.ID, Name: g.Name}
		for _, p := range pts {
			t := p.Time()
			cpu, ok := p.F("cpu")
			if !ok || t < from {
				continue
			}
			mem, _ := p.F("mem")
			gs.T = append(gs.T, t)
			gs.CPU = append(gs.CPU, round1(cpu*100))
			gs.Mem = append(gs.Mem, int64(mem))
		}
		if len(gs.T) > 0 {
			ov.Samples = append(ov.Samples, gs)
		}
	}

	if len(ov.Trend.CPU) > 0 {
		i := 0
		for j, v := range ov.Trend.CPU {
			if v > ov.Trend.CPU[i] {
				i = j
			}
		}
		pk := &peakView{T: ov.Trend.T[i], CPU: ov.Trend.CPU[i], Delta: round1(ov.Trend.CPU[i] - ov.Load.Avg), Top: []string{}}
		// Quem mais consumiu (em núcleos) no instante do pico.
		type contrib struct {
			id    string
			cores float64
		}
		var cs []contrib
		for _, g := range running {
			if p := nearest(guestRRD[g.ID], pk.T); p != nil {
				cpu, _ := p.F("cpu")
				maxcpu, ok := p.F("maxcpu")
				if !ok {
					maxcpu = g.MaxCPU
				}
				cs = append(cs, contrib{g.ID, cpu * maxcpu})
			}
		}
		slices.SortFunc(cs, func(x, y contrib) int { return cmp.Compare(y.cores, x.cores) })
		for _, c := range cs[:min(2, len(cs))] {
			if c.cores > 0.05 {
				pk.Top = append(pk.Top, names[c.id])
			}
		}
		ov.Trend.Peak = pk
	}
	return ov, nil
}

// aggregateNodes soma o rrd dos nós num único CPU% e RAM% do cluster.
func aggregateNodes(byNode map[string][]pve.RRDPoint, from, to int64) trendView {
	type acc struct{ cpu, maxcpu, mem, memtotal float64 }
	sum := map[int64]*acc{}
	for _, pts := range byNode {
		for _, p := range pts {
			t := p.Time()
			cpu, ok := p.F("cpu")
			if !ok || t < from || t > to {
				continue
			}
			maxcpu, ok := p.F("maxcpu")
			if !ok || maxcpu == 0 {
				maxcpu = 1
			}
			mem, _ := firstF(p, "memused", "mem")
			memtotal, _ := firstF(p, "memtotal", "maxmem")
			a := sum[t]
			if a == nil {
				a = &acc{}
				sum[t] = a
			}
			a.cpu += cpu * maxcpu
			a.maxcpu += maxcpu
			a.mem += mem
			a.memtotal += memtotal
		}
	}
	tv := trendView{T: []int64{}, CPU: []float64{}, RAM: []float64{}, Backups: [][2]int64{}}
	keys := make([]int64, 0, len(sum))
	for t := range sum {
		keys = append(keys, t)
	}
	slices.Sort(keys)
	for _, t := range keys {
		a := sum[t]
		ram := 0.0
		if a.memtotal > 0 {
			ram = a.mem / a.memtotal * 100
		}
		tv.T = append(tv.T, t)
		tv.CPU = append(tv.CPU, round1(a.cpu/a.maxcpu*100))
		tv.RAM = append(tv.RAM, round1(ram))
	}
	return tv
}

// backupWindows junta as tasks de vzdump em intervalos sem sobreposição.
func backupWindows(tasks []pve.Task, from, to int64) [][2]int64 {
	var iv [][2]int64
	for _, t := range tasks {
		start, end := int64(t.StartTime), int64(t.EndTime)
		if end == 0 {
			end = to // ainda rodando
		}
		if end < from || start > to {
			continue
		}
		iv = append(iv, [2]int64{max(start, from), min(end, to)})
	}
	slices.SortFunc(iv, func(x, y [2]int64) int { return cmp.Compare(x[0], y[0]) })
	out := [][2]int64{}
	for _, w := range iv {
		// Junta janelas separadas por menos de 10 min (um guest atrás do outro).
		if n := len(out); n > 0 && w[0] <= out[n-1][1]+600 {
			out[n-1][1] = max(out[n-1][1], w[1])
			continue
		}
		out = append(out, w)
	}
	return out
}

func nearest(pts []pve.RRDPoint, t int64) pve.RRDPoint {
	var best pve.RRDPoint
	bestD := int64(math.MaxInt64)
	for _, p := range pts {
		if _, ok := p.F("cpu"); !ok {
			continue
		}
		d := p.Time() - t
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = p, d
		}
	}
	return best
}

func firstF(p pve.RRDPoint, keys ...string) (float64, bool) {
	for _, k := range keys {
		if v, ok := p.F(k); ok {
			return v, true
		}
	}
	return 0, false
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

// --- /api/nodes/{node} ---

type poolView struct {
	Name  string  `json:"name"`
	Kind  string  `json:"kind"` // zfs | storage
	Used  pve.Int `json:"used"`
	Total pve.Int `json:"total"`
}

type nodeDetail struct {
	Name       string      `json:"name"`
	Online     bool        `json:"online"`
	IP         string      `json:"ip"`
	CPU        float64     `json:"cpu"`
	Threads    int         `json:"threads"`
	Cores      int         `json:"cores"`
	Sockets    int         `json:"sockets"`
	Model      string      `json:"model"`
	Load       []string    `json:"load"`
	MemUsed    int64       `json:"memUsed"`
	MemTotal   int64       `json:"memTotal"`
	Uptime     int64       `json:"uptime"`
	PVEVersion string      `json:"pveVersion"`
	Kernel     string      `json:"kernel"`
	Pool       *poolView   `json:"pool"`
	Guests     []guestView `json:"guests"`
}

func (s *Server) handleNode(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	name := r.PathValue("node")
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	i := slices.IndexFunc(res, func(x pve.Resource) bool { return x.Type == "node" && x.Node == name })
	if i < 0 {
		writeErr(w, http.StatusNotFound, "nó não encontrado")
		return
	}
	nd, err := cached(s.cache, a.User, "node:"+name, 5*time.Second, func() (*nodeDetail, error) {
		return s.buildNode(r.Context(), a, res, res[i])
	})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, nd)
}

func (s *Server) buildNode(ctx context.Context, a pve.Auth, res []pve.Resource, n pve.Resource) (*nodeDetail, error) {
	nd := &nodeDetail{Name: n.Node, Online: n.Status == "online", IP: s.nodeIPs(ctx, a)[n.Node],
		Uptime: n.Uptime, Load: []string{}, Guests: []guestView{}}
	for _, r := range res {
		if r.IsGuest() && r.Node == n.Node {
			nd.Guests = append(nd.Guests, toGuest(r))
		}
	}
	slices.SortFunc(nd.Guests, func(x, y guestView) int { return x.VMID - y.VMID })
	if !nd.Online {
		return nd, nil
	}

	var (
		wg     sync.WaitGroup
		st     pve.NodeStatus
		stErr  error
		pools  []pve.ZFSPool
		stores []pve.Storage
	)
	wg.Add(3)
	go func() { defer wg.Done(); st, stErr = s.pve.NodeStatus(ctx, &a, n.Node) }()
	go func() { defer wg.Done(); pools, _ = s.pve.ZFSPools(ctx, &a, n.Node) }()
	go func() { defer wg.Done(); stores, _ = s.pve.NodeStorage(ctx, &a, n.Node, "") }()
	wg.Wait()
	if stErr != nil {
		return nil, stErr
	}

	nd.CPU = round1(st.CPU * 100)
	nd.Threads, nd.Cores, nd.Sockets = st.CPUInfo.CPUs, st.CPUInfo.Cores, st.CPUInfo.Sockets
	nd.Model = cleanModel(st.CPUInfo.Model)
	nd.Load = st.LoadAvg
	nd.MemUsed, nd.MemTotal = st.Memory.Used, st.Memory.Total
	nd.Uptime = st.Uptime
	if v := strings.Split(st.PVEVersion, "/"); len(v) > 1 {
		nd.PVEVersion = v[1]
	}
	nd.Kernel = st.KVersion

	// Mostra o maior pool ZFS; sem ZFS, o maior storage local ativo.
	if len(pools) > 0 {
		p := slices.MaxFunc(pools, func(x, y pve.ZFSPool) int { return cmp.Compare(x.Size, y.Size) })
		nd.Pool = &poolView{Name: p.Name, Kind: "zfs", Used: p.Alloc, Total: p.Size}
	} else {
		var best *pve.Storage
		for i := range stores {
			sto := &stores[i]
			if sto.Active && !sto.Shared && (best == nil || sto.Total > best.Total) {
				best = sto
			}
		}
		if best != nil {
			nd.Pool = &poolView{Name: best.Storage, Kind: "storage", Used: best.Used, Total: best.Total}
		}
	}
	return nd, nil
}

// cleanModel encurta "AMD Ryzen 9 5900X 12-Core Processor" pra "Ryzen 9 5900X".
func cleanModel(m string) string {
	for _, junk := range []string{"(R)", "(TM)", "(tm)", " CPU", " Processor"} {
		m = strings.ReplaceAll(m, junk, "")
	}
	fields := strings.Fields(m)
	out := fields[:0]
	for i, f := range fields {
		gen := f == "Gen" || (i+1 < len(fields) && fields[i+1] == "Gen") // "12th Gen"
		if gen || f == "AMD" || f == "Intel" || f == "@" || strings.HasSuffix(f, "-Core") || strings.HasSuffix(f, "GHz") {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

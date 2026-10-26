// Package demo sobe um Proxmox de mentira (só os endpoints que o Mia usa)
// com um homelab de 3 nós e métricas sintéticas mas plausíveis. Serve pra
// desenvolver o front fora de um host PVE e pra testes.
//
// Login: qualquer usuário/senha (menos a senha "errada"). Usuário que começa
// com "tfa" pede segundo fator; o código é 123456.
package demo

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

const gib = int64(1) << 30

type node struct {
	name    string
	ip      string
	model   string
	threads int
	cores   int
	mem     int64
	pool    int64 // tamanho do pool zfs (0 = sem zfs)
	poolUse float64
	boot    time.Time
}

type guest struct {
	vmid     int
	name     string
	kind     string // qemu | lxc
	node     string
	cores    int
	mem      int64
	disk     int64
	memUse   float64 // fração típica de RAM usada
	profile  func(h float64, n float64) float64
	status   string
	template bool
	tags     string
}

var nodes = []*node{
	{name: "pve-01", ip: "10.0.10.11", model: "AMD Ryzen 9 5900X 12-Core Processor", threads: 24, cores: 12, mem: 64 * gib, pool: 8e12, poolUse: 0.39, boot: time.Now().Add(-(23*24 + 4) * time.Hour)},
	{name: "pve-02", ip: "10.0.10.12", model: "12th Gen Intel(R) Core(TM) i7-12700", threads: 20, cores: 12, mem: 64 * gib, pool: 4e12, poolUse: 0.31, boot: time.Now().Add(-(11*24 + 9) * time.Hour)},
	{name: "pve-03", ip: "10.0.10.13", model: "Intel(R) N100", threads: 4, cores: 4, mem: 16 * gib, boot: time.Now().Add(-(61*24 + 2) * time.Hour)},
}

// Perfis de CPU (fração da alocação) por hora do dia h e ruído n em [0,1).
func idle(base float64) func(float64, float64) float64 {
	return func(h, n float64) float64 { return base + 0.1*n*n + 0.1*bump(h, 14, 5) }
}

func bump(h, center, width float64) float64 {
	d := math.Abs(h - center)
	d = math.Min(d, 24-d)
	return math.Exp(-(d * d) / (2 * width * width))
}

var guests = []*guest{
	{vmid: 101, name: "jellyfin", kind: "lxc", node: "pve-01", cores: 4, mem: 8 * gib, disk: 32 * gib, memUse: 0.47, tags: "media",
		profile: func(h, n float64) float64 { return 0.05 + 0.55*bump(h, 21, 1.8)*n + 0.38*bump(h, 9.5, 0.6) + 0.05*n }},
	{vmid: 102, name: "vlad", kind: "qemu", node: "pve-01", cores: 8, mem: 16 * gib, disk: 128 * gib, memUse: 0.69, tags: "dev",
		profile: func(h, n float64) float64 { return 0.08 + 0.3*bump(h, 13, 3.5) + 0.35*bump(h, 9.5, 0.7) + 0.25*n*n }},
	{vmid: 103, name: "minecraft", kind: "lxc", node: "pve-02", cores: 4, mem: 12 * gib, disk: 40 * gib, memUse: 0.8, tags: "games",
		profile: func(h, n float64) float64 { return 0.22 + 0.62*bump(h, 21.5, 3.2) + 0.5*bump(h, 9.5, 1.2) + 0.08*n }},
	{vmid: 104, name: "n8n", kind: "lxc", node: "pve-01", cores: 2, mem: 2 * gib, disk: 8 * gib, memUse: 0.41, tags: "automation", profile: idle(0.04)},
	{vmid: 105, name: "tailscale-gw", kind: "lxc", node: "pve-03", cores: 1, mem: gib / 2, disk: 4 * gib, memUse: 0.3, tags: "network", profile: idle(0.02)},
	{vmid: 106, name: "adguard", kind: "lxc", node: "pve-03", cores: 1, mem: gib, disk: 4 * gib, memUse: 0.35, tags: "network", profile: idle(0.03)},
	{vmid: 107, name: "homeassistant", kind: "qemu", node: "pve-02", cores: 2, mem: 4 * gib, disk: 32 * gib, memUse: 0.55, tags: "home", profile: func(h, n float64) float64 { return 0.18 + 0.25*n + 0.1*bump(h, 19, 3) }},
	{vmid: 108, name: "nextcloud", kind: "lxc", node: "pve-02", cores: 4, mem: 6 * gib, disk: 64 * gib, memUse: 0.5, tags: "cloud",
		profile: func(h, n float64) float64 { return 0.06 + 0.2*bump(h, 15, 4)*n + 0.04*n }},
	{vmid: 109, name: "postgres", kind: "lxc", node: "pve-03", cores: 2, mem: 4 * gib, disk: 32 * gib, memUse: 0.62, tags: "db",
		profile: func(h, n float64) float64 { return 0.05 + 0.18*bump(h, 13, 4) + 0.06*n }},
	{vmid: 110, name: "win11-lab", kind: "qemu", node: "pve-01", cores: 8, mem: 16 * gib, disk: 128 * gib, memUse: 0.6, tags: "lab", profile: idle(0.1), status: "stopped"},
	{vmid: 111, name: "grafana", kind: "lxc", node: "pve-03", cores: 1, mem: gib, disk: 8 * gib, memUse: 0.4, tags: "monitoring", profile: idle(0.05)},
	{vmid: 112, name: "immich", kind: "lxc", node: "pve-02", cores: 4, mem: 8 * gib, disk: 64 * gib, memUse: 0.58, tags: "media",
		profile: func(h, n float64) float64 { return 0.04 + 0.55*bump(h, 3, 1) + 0.05*n }},
	{vmid: 113, name: "paperless", kind: "lxc", node: "pve-03", cores: 2, mem: 2 * gib, disk: 16 * gib, memUse: 0.5, tags: "docs", profile: idle(0.03)},
	{vmid: 114, name: "traefik", kind: "lxc", node: "pve-01", cores: 1, mem: gib / 2, disk: 4 * gib, memUse: 0.3, tags: "network", profile: idle(0.03)},
	{vmid: 115, name: "gitea", kind: "lxc", node: "pve-02", cores: 2, mem: 2 * gib, disk: 16 * gib, memUse: 0.45, tags: "dev",
		profile: func(h, n float64) float64 { return 0.03 + 0.15*bump(h, 11, 3)*n }},
	{vmid: 9000, name: "debian-13-tpl", kind: "qemu", node: "pve-01", cores: 2, mem: 2 * gib, disk: 16 * gib, profile: idle(0), status: "stopped", template: true},
}

// Janelas diárias de backup (hora de início, duração) por nó.
var backupJobs = map[string][][2]float64{
	"pve-01": {{1.5, 1.6}},
	"pve-02": {{1.6, 1.2}, {16.6, 0.7}},
	"pve-03": {{1.8, 0.6}},
}

// noise é determinístico por (chave, instante) pra o gráfico não pular a cada refresh.
func noise(key int, t int64) float64 {
	x := uint64(key)*0x9E3779B97F4A7C15 ^ uint64(t)
	x ^= x >> 30
	x *= 0xBF58476D1CE4E5B9
	x ^= x >> 27
	x *= 0x94D049BB133111EB
	x ^= x >> 31
	return float64(x>>11) / float64(1<<53)
}

func hourOf(t int64) float64 {
	tm := time.Unix(t, 0)
	return float64(tm.Hour()) + float64(tm.Minute())/60
}

func inBackup(nodeName string, t int64) bool {
	h := hourOf(t)
	for _, j := range backupJobs[nodeName] {
		if h >= j[0] && h < j[0]+j[1] {
			return true
		}
	}
	return false
}

type Server struct {
	mu       sync.Mutex
	list     []*guest // guests do demo (cresce quando cria LXC/instala app)
	status   map[int]string
	running  map[string]time.Time // upid -> fim, de tasks disparadas no demo
	tasksBy  map[string]*task     // tasks com log (criar CT, baixar template...)
	nets     map[string]*netState
	vols     map[string][]volume // "node/storage" -> conteúdo
	confs    map[int]map[string]string
	jobs     []map[string]string
	fw       map[string]*fwState
	snaps    map[int][]snap
	aptRepos map[string][]repo
	termCmd  map[string]string // ticket do termproxy -> cmd (ex.: upgrade)
	srv      *httptest.Server
}

// guests devolve uma cópia da lista atual.
func (s *Server) guests() []*guest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*guest(nil), s.list...)
}

// Start sobe o PVE falso em 127.0.0.1 com TLS e devolve a URL base.
func Start() *Server {
	s := &Server{status: map[int]string{}, running: map[string]time.Time{}, tasksBy: map[string]*task{},
		list: append([]*guest(nil), guests...)}
	s.initManage()
	s.initExtra()
	s.initVM()
	for _, g := range s.list {
		st := g.status
		if st == "" {
			st = "running"
		}
		s.status[g.vmid] = st
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api2/json/access/domains", s.domains)
	mux.HandleFunc("POST /api2/json/access/ticket", s.ticket)
	mux.HandleFunc("GET /api2/json/version", s.auth(func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]string{"version": "9.0.6", "release": "9.0", "repoid": "49c767b70aeb6648"})
	}))
	mux.HandleFunc("GET /api2/json/cluster/status", s.auth(s.clusterStatus))
	mux.HandleFunc("GET /api2/json/cluster/resources", s.auth(s.resources))
	mux.HandleFunc("GET /api2/json/nodes/{node}/status", s.auth(s.nodeStatus))
	mux.HandleFunc("GET /api2/json/nodes/{node}/rrddata", s.auth(s.nodeRRD))
	mux.HandleFunc("GET /api2/json/nodes/{node}/{kind}/{vmid}/rrddata", s.auth(s.guestRRD))
	mux.HandleFunc("GET /api2/json/nodes/{node}/tasks", s.auth(s.tasks))
	mux.HandleFunc("GET /api2/json/nodes/{node}/disks/zfs", s.auth(s.zfs))
	mux.HandleFunc("GET /api2/json/nodes/{node}/storage", s.auth(s.storage))
	mux.HandleFunc("POST /api2/json/nodes/{node}/vzdump", s.auth(s.vzdump))
	mux.HandleFunc("POST /api2/json/nodes/{node}/{kind}/{vmid}/status/{action}", s.auth(s.guestAction))
	s.routesManage(mux)
	s.routesExtra(mux)
	s.routesVM(mux)
	s.routesPhase1(mux)
	s.srv = httptest.NewTLSServer(mux)
	return s
}

func (s *Server) URL() string { return s.srv.URL }
func (s *Server) Close()      { s.srv.Close() }

func reply(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"data": data})
}

func fail(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"data": nil, "message": msg + "\n"})
}

func (s *Server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("PVEAuthCookie")
		if err != nil || !strings.HasPrefix(c.Value, "PVE:") || strings.Contains(c.Value, "!tfa!") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("CSRFPreventionToken") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

func token() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) domains(w http.ResponseWriter, r *http.Request) {
	reply(w, []map[string]any{
		{"realm": "pam", "type": "pam", "comment": "Linux PAM standard authentication", "default": 1},
		{"realm": "pve", "type": "pve", "comment": "Proxmox VE authentication server"},
	})
}

func (s *Server) ticket(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	user, pass := r.PostForm.Get("username"), r.PostForm.Get("password")
	if ch := r.PostForm.Get("tfa-challenge"); ch != "" {
		if pass != "totp:123456" && !strings.HasPrefix(pass, "recovery:") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		reply(w, map[string]any{"username": user, "ticket": "PVE:" + user + ":" + token(), "CSRFPreventionToken": token()})
		return
	}
	if user == "" || pass == "" || pass == "errada" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if strings.HasPrefix(user, "tfa") && !strings.HasPrefix(pass, "PVE:") {
		reply(w, map[string]any{"username": user, "ticket": "PVE:" + user + ":!tfa!" + token(), "NeedTFA": 1})
		return
	}
	reply(w, map[string]any{"username": user, "ticket": "PVE:" + user + ":" + token(), "CSRFPreventionToken": token()})
}

func (s *Server) clusterStatus(w http.ResponseWriter, r *http.Request) {
	rows := []map[string]any{{"type": "cluster", "id": "cluster", "name": "homelab", "nodes": len(nodes), "quorate": 1, "version": 7}}
	for i, n := range nodes {
		rows = append(rows, map[string]any{"type": "node", "id": "node/" + n.name, "name": n.name, "ip": n.ip,
			"online": 1, "local": b2i(i == 0), "nodeid": i + 1, "level": ""})
	}
	reply(w, rows)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// guestCPU devolve a fração de CPU (da alocação) do guest no instante t.
func guestCPU(g *guest, t int64) float64 {
	n := noise(g.vmid, t/60)
	v := g.profile(hourOf(t), n)
	if inBackup(g.node, t) {
		v += 0.12 * noise(g.vmid+7, t/60)
	}
	return math.Max(0.002, math.Min(0.99, v))
}

func guestMem(g *guest, t int64) int64 {
	return int64(float64(g.mem) * math.Min(0.97, g.memUse+0.06*noise(g.vmid+3, t/600)))
}

func (s *Server) statusOf(vmid int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status[vmid]
}

func (s *Server) isRunning(g *guest) bool { return s.statusOf(g.vmid) == "running" }

func nodeCPU(n *node, list []*guest, t int64, running func(*guest) bool) float64 {
	used := 1.2 // overhead do host (pveproxy, zfs, corosync)
	for _, g := range list {
		if g.node == n.name && running(g) {
			used += guestCPU(g, t) * float64(g.cores)
		}
	}
	if inBackup(n.name, t) {
		used += 1.5
	}
	return math.Min(1, used/float64(n.threads))
}

func nodeMem(n *node, list []*guest, t int64, running func(*guest) bool) int64 {
	used := int64(float64(n.mem) * 0.18) // host + ARC
	for _, g := range list {
		if g.node == n.name && running(g) {
			used += guestMem(g, t)
		}
	}
	return min(used, n.mem)
}

func (s *Server) resources(w http.ResponseWriter, r *http.Request) {
	now := time.Now().Unix()
	list := s.guests()
	rows := []map[string]any{}
	for _, n := range nodes {
		rows = append(rows, map[string]any{"id": "node/" + n.name, "type": "node", "node": n.name, "status": "online",
			"cpu": nodeCPU(n, list, now, s.isRunning), "maxcpu": n.threads, "mem": nodeMem(n, list, now, s.isRunning), "maxmem": n.mem,
			"disk": 12 * gib, "maxdisk": 94 * gib, "uptime": now - n.boot.Unix(), "level": ""})
		for _, st := range storages(n) {
			rows = append(rows, map[string]any{"id": "storage/" + n.name + "/" + st["storage"].(string), "type": "storage",
				"node": n.name, "storage": st["storage"], "status": "available", "plugintype": st["type"],
				"disk": st["used"], "maxdisk": st["total"], "content": st["content"], "shared": st["shared"]})
		}
	}
	for _, g := range list {
		running := s.isRunning(g)
		row := map[string]any{"id": fmt.Sprintf("%s/%d", g.kind, g.vmid), "type": g.kind, "node": g.node, "vmid": g.vmid,
			"name": g.name, "status": s.statusOf(g.vmid), "maxcpu": g.cores, "maxmem": g.mem, "maxdisk": g.disk,
			"disk": g.disk / 3, "template": b2i(g.template), "tags": g.tags, "cpu": 0, "mem": 0, "uptime": 0}
		if running {
			row["cpu"] = guestCPU(g, now)
			row["mem"] = guestMem(g, now)
			row["uptime"] = 3600*24*5 + g.vmid*1000
		}
		rows = append(rows, row)
	}
	reply(w, rows)
}

func findNode(name string) *node {
	for _, n := range nodes {
		if n.name == name {
			return n
		}
	}
	return nil
}

func (s *Server) nodeStatus(w http.ResponseWriter, r *http.Request) {
	n := findNode(r.PathValue("node"))
	if n == nil {
		fail(w, 404, "no such node")
		return
	}
	now := time.Now().Unix()
	list := s.guests()
	cpu := nodeCPU(n, list, now, s.isRunning)
	mem := nodeMem(n, list, now, s.isRunning)
	load := cpu * float64(n.threads) * 0.8
	reply(w, map[string]any{
		"cpu":        cpu,
		"loadavg":    []string{fmt.Sprintf("%.2f", load), fmt.Sprintf("%.2f", load*0.92), fmt.Sprintf("%.2f", load*0.85)},
		"uptime":     now - n.boot.Unix(),
		"cpuinfo":    map[string]any{"model": n.model, "cpus": n.threads, "cores": n.cores, "sockets": 1, "mhz": "3700.000"},
		"memory":     map[string]any{"total": n.mem, "used": mem, "free": n.mem - mem},
		"pveversion": "pve-manager/9.0.6/49c767b70aeb6648",
		"kversion":   "Linux 6.14.8-2-pve #1 SMP PREEMPT_DYNAMIC PMX 6.14.8-2 (2025-07-22T10:04Z)",
	})
}

var timeframes = map[string][2]int64{ // duração, passo
	"hour":  {3600, 60},
	"day":   {86400, 300},
	"week":  {7 * 86400, 1800},
	"month": {30 * 86400, 10800},
	"year":  {365 * 86400, 86400},
}

// series gera os instantes do rrd e, pra cada um, a média de f ao longo do passo.
func series(tf string, f func(t int64) map[string]any) []map[string]any {
	spec, ok := timeframes[tf]
	if !ok {
		spec = timeframes["hour"]
	}
	dur, step := spec[0], spec[1]
	end := time.Now().Unix() / step * step
	out := []map[string]any{}
	for t := end - dur; t <= end; t += step {
		out = append(out, f(t))
	}
	return out
}

// avgOver faz a média de g em até 6 subamostras do passo, como o rrd faz.
func avgOver(t, step int64, g func(int64) float64) float64 {
	k := min(int64(6), max(1, step/60))
	var s float64
	for i := int64(0); i < k; i++ {
		s += g(t - step + (i+1)*step/k)
	}
	return s / float64(k)
}

func (s *Server) nodeRRD(w http.ResponseWriter, r *http.Request) {
	n := findNode(r.PathValue("node"))
	if n == nil {
		fail(w, 404, "no such node")
		return
	}
	tf := r.URL.Query().Get("timeframe")
	step := timeframes[tf][1]
	list := s.guests()
	// O histórico assume que todo mundo que está rodando agora rodou antes.
	reply(w, series(tf, func(t int64) map[string]any {
		cpu := avgOver(t, step, func(t int64) float64 { return nodeCPU(n, list, t, s.isRunning) })
		mem := avgOver(t, step, func(t int64) float64 { return float64(nodeMem(n, list, t, s.isRunning)) })
		return map[string]any{"time": t, "cpu": cpu, "maxcpu": n.threads, "memused": mem, "memtotal": n.mem,
			"loadavg": cpu * float64(n.threads) * 0.8}
	}))
}

func (s *Server) guestRRD(w http.ResponseWriter, r *http.Request) {
	vmid, _ := strconv.Atoi(r.PathValue("vmid"))
	var g *guest
	for _, x := range s.guests() {
		if x.vmid == vmid && x.kind == r.PathValue("kind") {
			g = x
		}
	}
	if g == nil {
		fail(w, 404, "no such guest")
		return
	}
	tf := r.URL.Query().Get("timeframe")
	step := timeframes[tf][1]
	reply(w, series(tf, func(t int64) map[string]any {
		if !s.isRunning(g) {
			return map[string]any{"time": t}
		}
		cpu := avgOver(t, step, func(t int64) float64 { return guestCPU(g, t) })
		n := noise(g.vmid+11, t/step)
		return map[string]any{"time": t, "maxcpu": g.cores, "maxmem": g.mem, "cpu": cpu,
			"mem":       avgOver(t, step, func(t int64) float64 { return float64(guestMem(g, t)) }),
			"netin":     cpu * float64(g.cores) * 3e6 * (0.5 + n),
			"netout":    cpu * float64(g.cores) * 1.2e6 * (0.5 + n),
			"diskread":  cpu * float64(g.cores) * 2e6 * n,
			"diskwrite": cpu * float64(g.cores) * 0.8e6 * (1 - n)}
	}))
}

func (s *Server) tasks(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("node")
	if vmid := r.URL.Query().Get("vmid"); vmid != "" {
		s.guestTasks(w, name, vmid)
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	now := time.Now()
	out := []map[string]any{}
	for d := 0; d < 400; d++ {
		day := time.Date(now.Year(), now.Month(), now.Day()-d, 0, 0, 0, 0, time.Local)
		if day.Unix()+86400 < since {
			break
		}
		for _, j := range backupJobs[name] {
			start := day.Add(time.Duration(j[0] * float64(time.Hour)))
			end := start.Add(time.Duration(j[1] * float64(time.Hour)))
			if start.After(now) || start.Unix() < since {
				continue
			}
			t := map[string]any{"upid": fmt.Sprintf("UPID:%s:%X:vzdump::root@pam:", name, start.Unix()), "type": "vzdump",
				"node": name, "user": "root@pam", "starttime": start.Unix(), "id": ""}
			if end.Before(now) {
				t["endtime"], t["status"] = end.Unix(), "OK"
			}
			out = append(out, t)
		}
	}
	s.mu.Lock()
	for upid, end := range s.running {
		if strings.HasPrefix(upid, "UPID:"+name+":") {
			start := end.Add(-3 * time.Minute)
			t := map[string]any{"upid": upid, "type": "vzdump", "node": name, "user": "root@pam", "starttime": start.Unix()}
			if end.Before(now) {
				t["endtime"], t["status"] = end.Unix(), "OK"
			}
			out = append(out, t)
		}
	}
	s.mu.Unlock()
	reply(w, out)
}

func (s *Server) zfs(w http.ResponseWriter, r *http.Request) {
	n := findNode(r.PathValue("node"))
	if n == nil || n.pool == 0 {
		reply(w, []any{})
		return
	}
	alloc := int64(float64(n.pool) * n.poolUse)
	reply(w, []map[string]any{{"name": "tank", "size": n.pool, "alloc": alloc, "free": n.pool - alloc, "health": "ONLINE", "frag": 4, "dedup": 1}})
}

func storages(n *node) []map[string]any {
	list := []map[string]any{
		{"storage": "local", "type": "dir", "content": "iso,vztmpl,backup", "total": 94 * gib, "used": 21 * gib, "shared": 0},
		{"storage": "nas-backup", "type": "pbs", "content": "backup", "total": 12e12, "used": 4.2e12, "shared": 1},
	}
	if n.pool > 0 {
		list = append(list, map[string]any{"storage": "tank", "type": "zfspool", "content": "images,rootdir",
			"total": n.pool, "used": int64(float64(n.pool) * n.poolUse), "shared": 0})
	} else {
		list = append(list, map[string]any{"storage": "local-lvm", "type": "lvmthin", "content": "images,rootdir",
			"total": 380 * gib, "used": 142 * gib, "shared": 0})
	}
	return list
}

func (s *Server) storage(w http.ResponseWriter, r *http.Request) {
	n := findNode(r.PathValue("node"))
	if n == nil {
		fail(w, 404, "no such node")
		return
	}
	content := r.URL.Query().Get("content")
	out := []map[string]any{}
	for _, st := range storages(n) {
		if content != "" && !strings.Contains(st["content"].(string), content) {
			continue
		}
		total, used := toI(st["total"]), toI(st["used"])
		st["avail"], st["active"], st["enabled"] = total-used, 1, 1
		out = append(out, st)
	}
	reply(w, out)
}

func toI(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	case int:
		return int64(x)
	}
	return 0
}

func (s *Server) vzdump(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("node")
	upid := fmt.Sprintf("UPID:%s:%X:vzdump::root@pam:", name, time.Now().UnixNano())
	s.mu.Lock()
	s.running[upid] = time.Now().Add(3 * time.Minute)
	s.mu.Unlock()
	reply(w, upid)
}

func (s *Server) guestAction(w http.ResponseWriter, r *http.Request) {
	vmid, _ := strconv.Atoi(r.PathValue("vmid"))
	action := r.PathValue("action")
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.status[vmid]
	if !ok {
		fail(w, 404, "no such guest")
		return
	}
	for _, g := range s.list {
		if g.vmid == vmid && g.template {
			fail(w, 500, "cannot start template")
			return
		}
	}
	switch action {
	case "start", "resume":
		if cur == "running" && action == "start" {
			fail(w, 500, fmt.Sprintf("VM %d already running", vmid))
			return
		}
		s.status[vmid] = "running"
	case "stop", "shutdown":
		s.status[vmid] = "stopped"
	case "suspend":
		s.status[vmid] = "paused"
		if r.FormValue("todisk") == "1" {
			s.status[vmid] = "stopped" // hibernada
		}
	}
	reply(w, fmt.Sprintf("UPID:%s:%X:qm%s:%d:root@pam:", r.PathValue("node"), time.Now().UnixNano(), action, vmid))
}

// guestTasks: histórico de um guest (o que rodou no demo + umas antigas).
func (s *Server) guestTasks(w http.ResponseWriter, node, vmid string) {
	now := time.Now()
	out := []map[string]any{}
	add := func(typ, status string, start time.Time, dur time.Duration) {
		out = append(out, map[string]any{"upid": fmt.Sprintf("UPID:%s:%08X:%08X:%08X:%s:%s:root@pam:", node, start.Unix()%0xFFFFFF, 0, start.Unix(), typ, vmid),
			"node": node, "type": typ, "id": vmid, "user": "root@pam", "starttime": start.Unix(), "endtime": start.Add(dur).Unix(), "status": status})
	}
	add("vzstart", "OK", now.Add(-6*24*time.Hour), 3*time.Second)
	add("vzdump", "OK", now.Add(-26*time.Hour), 4*time.Minute)
	add("vzdump", "OK", now.Add(-2*time.Hour), 4*time.Minute)
	s.mu.Lock()
	for upid, t := range s.tasksBy {
		if t.id == vmid {
			row := map[string]any{"upid": upid, "node": t.node, "type": t.typ, "id": t.id, "user": "root@pam", "starttime": t.start.Unix()}
			if time.Since(t.start) >= t.dur {
				row["endtime"], row["status"] = t.start.Add(t.dur).Unix(), t.exit
			}
			out = append(out, row)
		}
	}
	s.mu.Unlock()
	reply(w, out)
}

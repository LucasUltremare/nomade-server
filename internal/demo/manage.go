package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Parte "de gestão" do Proxmox falso: tasks com log, terminal (termproxy +
// vncwebsocket com um shell de mentira), criar LXC, templates, rede e
// conteúdo dos storages.

func (s *Server) routesManage(mux *http.ServeMux) {
	mux.HandleFunc("GET /api2/json/cluster/nextid", s.auth(s.nextID))
	mux.HandleFunc("GET /api2/json/nodes/{node}/tasks/{upid}/status", s.auth(s.taskStatus))
	mux.HandleFunc("GET /api2/json/nodes/{node}/tasks/{upid}/log", s.auth(s.taskLog))

	mux.HandleFunc("POST /api2/json/nodes/{node}/termproxy", s.auth(s.termproxy))
	mux.HandleFunc("POST /api2/json/nodes/{node}/lxc/{vmid}/termproxy", s.auth(s.termproxy))
	mux.HandleFunc("GET /api2/json/nodes/{node}/vncwebsocket", s.auth(s.vncwebsocket))
	mux.HandleFunc("GET /api2/json/nodes/{node}/lxc/{vmid}/vncwebsocket", s.auth(s.vncwebsocket))

	mux.HandleFunc("GET /api2/json/nodes/{node}/aplinfo", s.auth(s.aplinfo))
	mux.HandleFunc("POST /api2/json/nodes/{node}/aplinfo", s.auth(s.aplDownload))
	mux.HandleFunc("POST /api2/json/nodes/{node}/lxc", s.auth(s.createGuest))
	mux.HandleFunc("POST /api2/json/nodes/{node}/qemu", s.auth(s.createGuest))

	mux.HandleFunc("GET /api2/json/nodes/{node}/network", s.auth(s.netList))
	mux.HandleFunc("POST /api2/json/nodes/{node}/network", s.auth(s.netCreate))
	mux.HandleFunc("PUT /api2/json/nodes/{node}/network", s.auth(s.netApply))
	mux.HandleFunc("DELETE /api2/json/nodes/{node}/network", s.auth(s.netRevert))
	mux.HandleFunc("DELETE /api2/json/nodes/{node}/network/{iface}", s.auth(s.netDelete))

	mux.HandleFunc("GET /api2/json/nodes/{node}/storage/{storage}/content", s.auth(s.content))
	mux.HandleFunc("DELETE /api2/json/nodes/{node}/storage/{storage}/content/{volid}", s.auth(s.contentDelete))
	mux.HandleFunc("POST /api2/json/nodes/{node}/storage/{storage}/upload", s.auth(s.upload))
	mux.HandleFunc("POST /api2/json/nodes/{node}/storage/{storage}/download-url", s.auth(s.downloadURL))
}

// ---------- tasks ----------

type task struct {
	node, typ, id string
	start         time.Time
	dur           time.Duration
	lines         []string
	exit          string
}

// newTask registra uma task que "roda" por dur, revelando o log aos poucos,
// e chama done quando termina.
func (s *Server) newTask(node, typ, id string, dur time.Duration, lines []string, done func()) string {
	now := time.Now()
	upid := fmt.Sprintf("UPID:%s:%08X:%08X:%08X:%s:%s:root@pam:", node, now.UnixNano()%0xFFFFFF, now.Unix()%0xFFFFFF, now.Unix(), typ, id)
	s.mu.Lock()
	s.tasksBy[upid] = &task{node: node, typ: typ, id: id, start: now, dur: dur, lines: lines, exit: "OK"}
	s.mu.Unlock()
	if done != nil {
		time.AfterFunc(dur, done)
	}
	return upid
}

func (s *Server) taskStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	t := s.tasksBy[r.PathValue("upid")]
	s.mu.Unlock()
	if t == nil {
		reply(w, map[string]any{"status": "stopped", "exitstatus": "OK"})
		return
	}
	st := map[string]any{"status": "running", "type": t.typ, "id": t.id, "starttime": t.start.Unix()}
	if time.Since(t.start) >= t.dur {
		st["status"], st["exitstatus"] = "stopped", t.exit
	}
	reply(w, st)
}

func (s *Server) taskLog(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	t := s.tasksBy[r.PathValue("upid")]
	s.mu.Unlock()
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	out := []map[string]any{}
	if t != nil {
		frac := min(1, float64(time.Since(t.start))/float64(t.dur))
		shown := int(frac * float64(len(t.lines)))
		if frac >= 1 {
			shown = len(t.lines) + 1
		}
		for i := start; i < shown; i++ {
			line := "TASK OK"
			if i < len(t.lines) {
				line = t.lines[i]
			}
			out = append(out, map[string]any{"n": i + 1, "t": line})
		}
	}
	reply(w, out)
}

func (s *Server) nextID(w http.ResponseWriter, r *http.Request) {
	reply(w, strconv.Itoa(s.freeID()))
}

func (s *Server) freeID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := 100
	for {
		taken := slices.ContainsFunc(s.list, func(g *guest) bool { return g.vmid == id })
		if !taken {
			return id
		}
		id++
	}
}

func (s *Server) addGuest(g *guest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = append(s.list, g)
	if g.status == "" {
		g.status = "running"
	}
	s.status[g.vmid] = g.status
}

func (s *Server) hasGuest(vmid int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.list, func(g *guest) bool { return g.vmid == vmid })
}

// ---------- criar guest / restaurar ----------

func (s *Server) createGuest(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := r.PostForm
	kind := "lxc"
	if strings.HasSuffix(r.URL.Path, "/qemu") {
		kind = "qemu"
	}
	node := r.PathValue("node")
	vmid, _ := strconv.Atoi(f.Get("vmid"))
	if vmid < 100 {
		fail(w, 400, "invalid vmid")
		return
	}
	if s.hasGuest(vmid) {
		fail(w, 500, fmt.Sprintf("CT %d already exists on node '%s'", vmid, node))
		return
	}
	g := &guest{vmid: vmid, kind: kind, node: node, cores: 1, mem: gib, disk: 8 * gib, memUse: 0.3, profile: idle(0.04), status: "stopped", tags: f.Get("tags")}
	if n, _ := strconv.Atoi(f.Get("cores")); n > 0 {
		g.cores = n
	}
	if m, _ := strconv.Atoi(f.Get("memory")); m > 0 {
		g.mem = int64(m) << 20
	}
	for _, k := range []string{"rootfs", "scsi0", "sata0"} {
		if _, size, ok := strings.Cut(f.Get(k), ":"); ok {
			size, _, _ = strings.Cut(size, ",")
			if gb, _ := strconv.Atoi(size); gb > 0 {
				g.disk = int64(gb) * gib
			}
		}
	}
	g.name = f.Get("hostname") + f.Get("name")
	var lines []string
	typ := "vzcreate"
	switch {
	case f.Get("restore") == "1" || f.Get("archive") != "":
		src := f.Get("ostemplate") + f.Get("archive")
		if g.name == "" {
			g.name = fmt.Sprintf("restaurado-%d", vmid)
		}
		typ = map[string]string{"lxc": "vzrestore", "qemu": "qmrestore"}[kind]
		lines = []string{"restore " + src, "extracting archive '" + src + "'", "total bytes read 2147483648, sparse bytes 1073741824 (50%)", "Detected container architecture: amd64", "merging backed-up and given configuration.."}
	case kind == "qemu":
		typ = "qmcreate"
		lines = []string{
			fmt.Sprintf("%s: successfully created disk '%s:vm-%d-disk-0,size=%dG'", f.Get("scsihw"), diskStore(node), vmid, g.disk>>30),
			"ide2: " + f.Get("ide2"),
		}
		if f.Get("efidisk0") != "" {
			lines = append(lines, fmt.Sprintf("efidisk0: successfully created disk '%s:vm-%d-disk-1,efitype=4m,size=1M'", diskStore(node), vmid))
		}
	default:
		if g.name == "" {
			g.name = fmt.Sprintf("CT%d", vmid)
		}
		lines = []string{
			"Logical volume \"vm-" + strconv.Itoa(vmid) + "-disk-0\" created.",
			"Creating filesystem with 2097152 4k blocks and 524288 inodes",
			"extracting archive '" + f.Get("ostemplate") + "'",
			"Total bytes read: 523233280 (500MiB, 98MiB/s)",
			"Detected container architecture: amd64",
			"Creating SSH host key 'ssh_host_ed25519_key' - this may take some time ...",
			"done: SHA256:Qm3r1aNcT8bL0p9xkzE1yq+2vTg5cJ4mW7uH0fRZsYI root@" + g.name,
		}
	}
	start := f.Get("start") == "1"
	upid := s.newTask(node, typ, strconv.Itoa(vmid), 4*time.Second, lines, func() {
		if start {
			g.status = "running"
		}
		s.addGuest(g)
	})
	reply(w, upid)
}

// ---------- templates ----------

var aplTemplates = []map[string]string{
	{"template": "debian-13-standard_13.1-2_amd64.tar.zst", "os": "debian-13", "version": "13.1-2", "headline": "Debian 13 (standard)", "section": "system"},
	{"template": "debian-12-standard_12.12-1_amd64.tar.zst", "os": "debian-12", "version": "12.12-1", "headline": "Debian 12 Bookworm (standard)", "section": "system"},
	{"template": "ubuntu-24.04-standard_24.04-2_amd64.tar.zst", "os": "ubuntu-24.04", "version": "24.04-2", "headline": "Ubuntu 24.04 Noble (standard)", "section": "system"},
	{"template": "alpine-3.22-default_20250617_amd64.tar.xz", "os": "alpine-3.22", "version": "20250617", "headline": "Alpine Linux 3.22 (default)", "section": "system"},
	{"template": "rockylinux-9-default_20240912_amd64.tar.xz", "os": "rockylinux-9", "version": "20240912", "headline": "Rocky Linux 9 (default)", "section": "system"},
	{"template": "turnkey-wordpress_18.2-1_amd64.tar.gz", "os": "debian-12", "version": "18.2-1", "headline": "TurnKey WordPress", "section": "turnkeylinux"},
}

func (s *Server) aplinfo(w http.ResponseWriter, r *http.Request) { reply(w, aplTemplates) }

func (s *Server) aplDownload(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	node, store, tmpl := r.PathValue("node"), r.PostForm.Get("storage"), r.PostForm.Get("template")
	lines := []string{
		"starting template download from: http://download.proxmox.com/images/system/" + tmpl,
		"target file: /var/lib/vz/template/cache/" + tmpl,
		" 25% (130.8 MiB of 523.2 MiB) in 1s", " 63% (329.6 MiB of 523.2 MiB) in 2s", "100% (523.2 MiB of 523.2 MiB) in 3s",
		"download of '" + tmpl + "' to '/var/lib/vz/template/cache/" + tmpl + "' finished",
	}
	reply(w, s.newTask(node, "download", tmpl, 3*time.Second, lines, func() {
		s.addVolume(node, store, volume{volid: store + ":vztmpl/" + tmpl, content: "vztmpl", format: "tzst", size: 523 << 20, ctime: time.Now().Unix()})
	}))
}

// ---------- storage ----------

type volume struct {
	volid, content, format string
	size, ctime            int64
	vmid                   int
}

func volKey(node, storage string) string {
	if storage == "nas-backup" {
		return "shared/" + storage
	}
	return node + "/" + storage
}

func (s *Server) initManage() {
	s.vols = map[string][]volume{}
	s.nets = map[string]*netState{}
	day := time.Now().Truncate(24 * time.Hour)
	for _, n := range nodes {
		local := volKey(n.name, "local")
		s.vols[local] = []volume{
			{volid: "local:iso/debian-13.1.0-amd64-netinst.iso", content: "iso", format: "iso", size: 784 << 20, ctime: day.Add(-40 * 24 * time.Hour).Unix()},
			{volid: "local:iso/ubuntu-24.04.3-live-server-amd64.iso", content: "iso", format: "iso", size: 3 << 30, ctime: day.Add(-90 * 24 * time.Hour).Unix()},
			{volid: "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst", content: "vztmpl", format: "tzst", size: 120 << 20, ctime: day.Add(-120 * 24 * time.Hour).Unix()},
		}
		if n.name == "pve-01" {
			s.vols[local] = append(s.vols[local], volume{volid: "local:iso/Win11_24H2_BrazilianPortuguese_x64.iso", content: "iso", format: "iso", size: 5600 << 20, ctime: day.Add(-20 * 24 * time.Hour).Unix()})
		}
		disk := "tank"
		if n.pool == 0 {
			disk = "local-lvm"
		}
		for _, g := range guests {
			if g.node != n.name {
				continue
			}
			name := fmt.Sprintf("%s:subvol-%d-disk-0", disk, g.vmid)
			content := "rootdir"
			if g.kind == "qemu" {
				name, content = fmt.Sprintf("%s:vm-%d-disk-0", disk, g.vmid), "images"
			}
			s.vols[volKey(n.name, disk)] = append(s.vols[volKey(n.name, disk)], volume{volid: name, content: content, format: "raw", size: g.disk, vmid: g.vmid, ctime: day.Add(-200 * 24 * time.Hour).Unix()})
			if g.template {
				continue
			}
			for d := 1; d <= 3; d++ {
				ts := day.Add(-time.Duration(d) * 24 * time.Hour).Add(90 * time.Minute)
				kind := map[string]string{"lxc": "ct", "qemu": "vm"}[g.kind]
				s.vols[volKey(n.name, "nas-backup")] = append(s.vols[volKey(n.name, "nas-backup")], volume{
					volid:   fmt.Sprintf("nas-backup:backup/%s/%d/%s", kind, g.vmid, ts.UTC().Format("2006-01-02T15:04:05Z")),
					content: "backup", format: "pbs-" + kind, size: g.disk / 4, vmid: g.vmid, ctime: ts.Unix()})
			}
		}
		s.nets[n.name] = initNet(n)
	}
}

func (s *Server) addVolume(node, storage string, v volume) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := volKey(node, storage)
	s.vols[k] = append(s.vols[k], v)
}

func (s *Server) content(w http.ResponseWriter, r *http.Request) {
	want := r.URL.Query().Get("content")
	s.mu.Lock()
	list := slices.Clone(s.vols[volKey(r.PathValue("node"), r.PathValue("storage"))])
	s.mu.Unlock()
	out := []map[string]any{}
	for _, v := range list {
		if want != "" && v.content != want {
			continue
		}
		row := map[string]any{"volid": v.volid, "content": v.content, "format": v.format, "size": v.size, "ctime": v.ctime}
		if strings.HasPrefix(v.volid, "nas-backup:") {
			// Igual a alguns plugins do PVE real: números como texto.
			row["ctime"], row["size"] = strconv.FormatInt(v.ctime, 10), strconv.FormatInt(v.size, 10)
		}
		if v.vmid > 0 {
			row["vmid"] = v.vmid
		}
		out = append(out, row)
	}
	reply(w, out)
}

func (s *Server) contentDelete(w http.ResponseWriter, r *http.Request) {
	volid := r.PathValue("volid")
	k := volKey(r.PathValue("node"), r.PathValue("storage"))
	s.mu.Lock()
	before := len(s.vols[k])
	s.vols[k] = slices.DeleteFunc(s.vols[k], func(v volume) bool { return v.volid == volid })
	removed := len(s.vols[k]) < before
	s.mu.Unlock()
	if !removed {
		fail(w, 500, "volume '"+volid+"' does not exist")
		return
	}
	reply(w, s.newTask(r.PathValue("node"), "imgdel", volid, time.Second, []string{"Removed volume '" + volid + "'"}, nil))
}

func formatOf(name string) string {
	switch {
	case strings.HasSuffix(name, ".iso"):
		return "iso"
	case strings.HasSuffix(name, ".tar.zst"):
		return "tzst"
	case strings.HasSuffix(name, ".tar.xz"):
		return "txz"
	case strings.HasSuffix(name, ".tar.gz"):
		return "tgz"
	case strings.HasSuffix(name, ".qcow2"):
		return "qcow2"
	}
	return "raw"
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	node, store := r.PathValue("node"), r.PathValue("storage")
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "expected multipart")
		return
	}
	content, name := "", ""
	var size int64
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		switch p.FormName() {
		case "content":
			b, _ := io.ReadAll(p)
			content = string(b)
		case "filename":
			name = p.FileName()
			size, _ = io.Copy(io.Discard, p)
		}
	}
	if name == "" || (content != "iso" && content != "vztmpl" && content != "import") {
		fail(w, 400, "missing file or content")
		return
	}
	lines := []string{fmt.Sprintf("starting file import from: /var/tmp/pveupload-%x", time.Now().UnixNano()%0xFFFFFF),
		fmt.Sprintf("target node: %s", node), fmt.Sprintf("target file: /var/lib/vz/template/%s/%s", content, name),
		fmt.Sprintf("file size is: %d", size), "command: cp -- /var/tmp/pveupload /var/lib/vz/template/" + content + "/" + name, "finished file import successfully"}
	reply(w, s.newTask(node, "imgcopy", "", 2*time.Second, lines, func() {
		s.addVolume(node, store, volume{volid: store + ":" + content + "/" + name, content: content, format: formatOf(name), size: size, ctime: time.Now().Unix()})
	}))
}

func (s *Server) downloadURL(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	node, store := r.PathValue("node"), r.PathValue("storage")
	u, name, content := r.PostForm.Get("url"), r.PostForm.Get("filename"), r.PostForm.Get("content")
	lines := []string{"downloading " + u + " to /var/lib/vz/template/" + content + "/" + name + ".tmp",
		"--2026-10-26 11:40:12--  " + u, "Resolving host... connected.", "HTTP request sent, awaiting response... 200 OK",
		"Length: 1048576000 (1000M) [application/octet-stream]", "  10% [====>          ] 104.86M  52.4MB/s",
		"  55% [=========>     ] 576.72M  57.7MB/s", " 100% [==============>] 1000.00M 58.1MB/s    in 17s",
		"download of '" + u + "' to '/var/lib/vz/template/" + content + "/" + name + "' finished"}
	reply(w, s.newTask(node, "download", name, 5*time.Second, lines, func() {
		s.addVolume(node, store, volume{volid: store + ":" + content + "/" + name, content: content, format: formatOf(name), size: 1000 << 20, ctime: time.Now().Unix()})
	}))
}

// ---------- rede ----------

type iface struct {
	Iface, Type, Method, CIDR, Gateway, Ports, Comments, VLANRaw string
	VLANID                                                       int
	VLANAware, Active                                            bool
}

type netState struct {
	cur     []iface
	pending []iface // nil = sem mudanças pendentes
}

func initNet(n *node) *netState {
	last := n.ip[strings.LastIndex(n.ip, ".")+1:]
	ns := &netState{cur: []iface{
		{Iface: "enp5s0", Type: "eth", Method: "manual", Active: true},
		{Iface: "vmbr0", Type: "bridge", Method: "static", CIDR: n.ip + "/24", Gateway: "10.0.10.1", Ports: "enp5s0", Active: true},
	}}
	if n.name == "pve-01" {
		ns.cur = append(ns.cur,
			iface{Iface: "enp6s0", Type: "eth", Method: "manual", Active: true},
			iface{Iface: "vmbr1", Type: "bridge", Method: "manual", Ports: "enp6s0", VLANAware: true, Comments: "LAN IoT", Active: true},
			iface{Iface: "vmbr1.20", Type: "vlan", Method: "static", CIDR: "10.0.20." + last + "/24", VLANRaw: "vmbr1", VLANID: 20, Active: true, Comments: "câmeras"},
		)
	}
	return ns
}

func (i iface) row() map[string]any {
	row := map[string]any{"iface": i.Iface, "type": i.Type, "method": i.Method, "active": b2i(i.Active), "autostart": 1, "families": []string{"inet"}}
	for k, v := range map[string]string{"cidr": i.CIDR, "gateway": i.Gateway, "bridge_ports": i.Ports, "comments": i.Comments, "vlan-raw-device": i.VLANRaw} {
		if v != "" {
			row[k] = v
		}
	}
	if i.VLANAware {
		row["bridge_vlan_aware"] = 1
	}
	if i.VLANID > 0 {
		row["vlan-id"] = i.VLANID
	}
	return row
}

func (i iface) stanza() string {
	s := "iface " + i.Iface + " inet " + i.Method
	if i.CIDR != "" {
		s += "\n\taddress " + i.CIDR
	}
	if i.Ports != "" {
		s += "\n\tbridge-ports " + i.Ports
	}
	return s
}

func (s *Server) netList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	ns := s.nets[r.PathValue("node")]
	var list []iface
	changes := ""
	if ns != nil {
		list = ns.cur
		if ns.pending != nil {
			list = ns.pending
			for _, p := range ns.pending {
				if !slices.ContainsFunc(ns.cur, func(c iface) bool { return c.Iface == p.Iface }) {
					changes += "+" + strings.ReplaceAll(p.stanza(), "\n", "\n+") + "\n"
				}
			}
			for _, c := range ns.cur {
				if !slices.ContainsFunc(ns.pending, func(p iface) bool { return p.Iface == c.Iface }) {
					changes += "-" + strings.ReplaceAll(c.stanza(), "\n", "\n-") + "\n"
				}
			}
		}
	}
	s.mu.Unlock()
	typ := r.URL.Query().Get("type")
	rows := []map[string]any{}
	for _, i := range list {
		if typ == "any_bridge" && i.Type != "bridge" {
			continue
		}
		rows = append(rows, i.row())
	}
	w.Header().Set("Content-Type", "application/json")
	body := map[string]any{"data": rows}
	if changes != "" {
		body["changes"] = changes
	}
	writeJSONRaw(w, body)
}

func (s *Server) netCreate(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := r.PostForm
	i := iface{Iface: f.Get("iface"), Type: f.Get("type"), Method: "manual", CIDR: f.Get("cidr"), Gateway: f.Get("gateway"),
		Ports: f.Get("bridge_ports"), Comments: f.Get("comments"), VLANAware: f.Get("bridge_vlan_aware") == "1"}
	if i.CIDR != "" {
		i.Method = "static"
	}
	if i.Type == "vlan" {
		raw, id, _ := strings.Cut(i.Iface, ".")
		i.VLANRaw = raw
		i.VLANID, _ = strconv.Atoi(id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ns := s.nets[r.PathValue("node")]
	if ns.pending == nil {
		ns.pending = slices.Clone(ns.cur)
	}
	if slices.ContainsFunc(ns.pending, func(x iface) bool { return x.Iface == i.Iface }) {
		fail(w, 400, "interface '"+i.Iface+"' already exists")
		return
	}
	ns.pending = append(ns.pending, i)
	reply(w, nil)
}

func (s *Server) netDelete(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ns := s.nets[r.PathValue("node")]
	if ns.pending == nil {
		ns.pending = slices.Clone(ns.cur)
	}
	name := r.PathValue("iface")
	ns.pending = slices.DeleteFunc(ns.pending, func(x iface) bool { return x.Iface == name })
	reply(w, nil)
}

func (s *Server) netApply(w http.ResponseWriter, r *http.Request) {
	node := r.PathValue("node")
	s.mu.Lock()
	ns := s.nets[node]
	if ns.pending != nil {
		for i := range ns.pending {
			ns.pending[i].Active = true
		}
		ns.cur, ns.pending = ns.pending, nil
	}
	s.mu.Unlock()
	reply(w, s.newTask(node, "srvreload", "networking", 2*time.Second,
		[]string{"info: executing ifreload -a", "info: reloading ifupdown2 configuration", "info: done"}, nil))
}

func (s *Server) netRevert(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.nets[r.PathValue("node")].pending = nil
	s.mu.Unlock()
	reply(w, nil)
}

// ---------- terminal ----------

func (s *Server) termproxy(w http.ResponseWriter, r *http.Request) {
	vmid, _ := strconv.Atoi(r.PathValue("vmid"))
	if vmid > 0 && !s.hasGuest(vmid) {
		fail(w, 500, fmt.Sprintf("Configuration file 'nodes/%s/lxc/%d.conf' does not exist", r.PathValue("node"), vmid))
		return
	}
	reply(w, map[string]any{
		"port":   5900 + time.Now().Nanosecond()%100,
		"ticket": "PVEVNC:" + token(),
		"user":   "root@pam",
		"upid":   s.newTask(r.PathValue("node"), "vncshell", "", time.Hour, nil, nil),
	})
}

func (s *Server) vncwebsocket(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("vncticket") == "" {
		fail(w, 401, "permission denied - invalid vnc ticket")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()

	// Primeira mensagem: "usuário:ticket\n".
	_, first, err := c.Read(ctx)
	if err != nil || !strings.Contains(string(first), ":PVEVNC:") {
		c.Close(websocket.StatusPolicyViolation, "auth")
		return
	}
	host := r.PathValue("node")
	vmid, _ := strconv.Atoi(r.PathValue("vmid"))
	if vmid > 0 {
		for _, g := range s.guests() {
			if g.vmid == vmid {
				host = g.name
			}
		}
	}
	sh := &shell{s: s, c: c, ctx: ctx, node: r.PathValue("node"), host: host, ct: vmid > 0}
	sh.write("OK")
	sh.banner()
	for {
		_, msg, err := c.Read(ctx)
		if err != nil {
			return
		}
		m := string(msg)
		switch {
		case strings.HasPrefix(m, "0:"):
			if _, data, ok := strings.Cut(m[2:], ":"); ok {
				if sh.input(data) {
					c.Close(websocket.StatusNormalClosure, "logout")
					return
				}
			}
		case strings.HasPrefix(m, "1:"), m == "2":
			// resize / ping
		}
	}
}

type shell struct {
	s      *Server
	c      *websocket.Conn
	ctx    context.Context
	node   string
	host   string
	ct     bool
	mu     sync.Mutex
	line   []rune
	esc    int
	here   string // terminador do heredoc em andamento
	header string
	body   []string
}

func (sh *shell) write(s string) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	sh.c.Write(sh.ctx, websocket.MessageBinary, []byte(s))
}

func (sh *shell) out(lines ...string) {
	for _, l := range lines {
		sh.write(l + "\r\n")
	}
}

func (sh *shell) prompt() {
	sh.write("\x1b[1;32mroot@" + sh.host + "\x1b[0m:\x1b[1;34m~\x1b[0m# ")
}

func (sh *shell) banner() {
	if sh.ct {
		sh.out("", "Debian GNU/Linux 13 "+sh.host+" tty1", "", sh.host+" login: root (automatic login)", "")
	} else {
		sh.out("", "Linux "+sh.node+" 6.14.8-2-pve #1 SMP PREEMPT_DYNAMIC PMX 6.14.8-2 x86_64", "",
			"The programs included with the Debian GNU/Linux system are free software.",
			"\x1b[2m(Mia demo: shell de mentira. Tente pveversion, pct list ou instale um app.)\x1b[0m", "")
	}
	sh.prompt()
}

func (sh *shell) sleep(d time.Duration) {
	select {
	case <-sh.ctx.Done():
	case <-time.After(d):
	}
}

// input processa as teclas; devolve true se a sessão deve fechar.
func (sh *shell) input(data string) bool {
	for _, ch := range data {
		if sh.esc > 0 { // ignora sequências de escape (setas etc.)
			if sh.esc == 1 && ch == '[' {
				sh.esc = 2
				continue
			}
			if ch >= '@' && ch <= '~' {
				sh.esc = 0
			}
			continue
		}
		switch ch {
		case 0x1b:
			sh.esc = 1
		case '\r', '\n':
			line := string(sh.line)
			sh.line = sh.line[:0]
			sh.write("\r\n")
			if sh.enter(line) {
				return true
			}
		case 0x7f, 0x08:
			if len(sh.line) > 0 {
				sh.line = sh.line[:len(sh.line)-1]
				sh.write("\b \b")
			}
		case 0x03:
			sh.line, sh.here, sh.body = sh.line[:0], "", nil
			sh.write("^C\r\n")
			sh.prompt()
		case 0x0c:
			sh.write("\x1b[2J\x1b[H")
			sh.prompt()
		default:
			if ch >= 0x20 {
				sh.line = append(sh.line, ch)
				sh.write(string(ch))
			}
		}
	}
	return false
}

var hereRe = regexp.MustCompile(`<<'(\w+)'`)

func (sh *shell) enter(line string) bool {
	if sh.here != "" {
		if strings.TrimSpace(line) == sh.here {
			sh.here = ""
			sh.runHeredoc(sh.header, sh.body)
			sh.body = nil
			sh.prompt()
			return false
		}
		sh.body = append(sh.body, line)
		sh.write("> ")
		return false
	}
	if m := hereRe.FindStringSubmatch(line); m != nil {
		sh.here, sh.header, sh.body = m[1], line, nil
		sh.write("> ")
		return false
	}
	cmd := strings.TrimSpace(line)
	cmd = strings.TrimSuffix(strings.TrimPrefix(cmd, "if "), "; then")
	switch {
	case cmd == "" || cmd == "fi":
	case cmd == "exit" || cmd == "logout":
		sh.out("logout")
		return true
	case cmd == "clear":
		sh.write("\x1b[2J\x1b[H")
	case cmd == "hostname":
		sh.out(sh.host)
	case cmd == "whoami":
		sh.out("root")
	case cmd == "pveversion":
		sh.out("pve-manager/9.0.6/49c767b70aeb6648 (running kernel: 6.14.8-2-pve)")
	case cmd == "uptime":
		sh.out(" " + time.Now().Format("15:04:05") + " up 23 days,  4:12,  1 user,  load average: 4.61, 4.32, 4.10")
	case cmd == "ls":
		sh.out("\x1b[1;34mscripts\x1b[0m  notes.txt")
	case cmd == "pct list" && !sh.ct:
		sh.out(fmt.Sprintf("%-10s %-10s %-6s %s", "VMID", "Status", "Lock", "Name"))
		for _, g := range sh.s.guests() {
			if g.kind == "lxc" && g.node == sh.node {
				sh.out(fmt.Sprintf("%-10d %-10s %-6s %s", g.vmid, sh.s.statusOf(g.vmid), "", g.name))
			}
		}
	case strings.Contains(cmd, "community-scripts/ProxmoxVE") && strings.Contains(cmd, ".sh"):
		sh.runScript(cmd)
	default:
		name := strings.Fields(cmd)[0]
		sh.out("-bash: " + name + ": command not found")
	}
	sh.prompt()
	return false
}

var (
	scriptRe = regexp.MustCompile(`ProxmoxVE/main/(ct|vm|tools/pve|tools/addon|turnkey)/([a-z0-9-]+)\.sh`)
	varRe    = regexp.MustCompile(`var_(cpu|ram|disk)="?(\d+)"?`)
	tsHostRe = regexp.MustCompile(`--hostname=([a-z0-9-]+)`)
	tsPortRe = regexp.MustCompile(`tailscale serve --bg (\d+)`)
)

func (sh *shell) step(msg string) {
	sh.write("  \x1b[33m⏳\x1b[0m  " + msg)
	sh.sleep(500 * time.Millisecond)
	sh.write("\r\x1b[K  ✔️  \x1b[1;92m" + msg + "\x1b[0m\r\n")
}

// runScript finge rodar um script do community-scripts e, se for de
// container/VM, cria o guest no demo.
func (sh *shell) runScript(cmd string) {
	m := scriptRe.FindStringSubmatch(cmd)
	if m == nil {
		sh.out("bash: erro de sintaxe")
		return
	}
	kind, slug := m[1], m[2]
	cpu, ram, disk := 2, 2048, 8
	for _, v := range varRe.FindAllStringSubmatch(cmd, -1) {
		n, _ := strconv.Atoi(v[2])
		switch v[1] {
		case "cpu":
			cpu = n
		case "ram":
			ram = n
		case "disk":
			disk = n
		}
	}
	title := strings.ToUpper(slug[:1]) + slug[1:]
	sh.out("", "\x1b[1;33m  "+strings.Repeat("─", 10)+" "+title+" "+strings.Repeat("─", 10)+"\x1b[0m", "")
	sh.out("  ⚙️  Using Default Settings on node "+sh.node, fmt.Sprintf("  🧠  CPU: %d · RAM: %d MiB · Disco: %d GB", cpu, ram, disk), "")
	switch kind {
	case "ct", "vm":
		id := sh.s.freeID()
		g := &guest{vmid: id, name: slug, kind: map[string]string{"ct": "lxc", "vm": "qemu"}[kind], node: sh.node,
			cores: cpu, mem: int64(ram) << 20, disk: int64(disk) * gib, memUse: 0.35, profile: idle(0.05), tags: "community-script"}
		sh.step("Validated storage tank")
		sh.step(fmt.Sprintf("Created %s %d", map[string]string{"ct": "LXC Container", "vm": "VM"}[kind], id))
		sh.s.addGuest(g)
		sh.step("Started " + map[string]string{"ct": "LXC Container", "vm": "VM"}[kind])
		sh.step("Set up Container OS")
		sh.step("Network connected")
		sh.step("Installed Dependencies")
		sh.step("Installed " + title)
		sh.step("Cleaned")
		sh.out("", "  ✔️  \x1b[1;92mCompleted Successfully!\x1b[0m", "",
			"  🚀  "+title+" setup has been successfully initialized!",
			"  💡  Access it using the following URL:",
			fmt.Sprintf("      🌐  http://10.0.10.%d", id-100+120), "")
	default:
		sh.step("Executed " + title)
		sh.out("", "  ✔️  \x1b[1;92mCompleted Successfully!\x1b[0m", "")
	}
}

func (sh *shell) runHeredoc(header string, body []string) {
	all := header + "\n" + strings.Join(body, "\n")
	host := "app"
	if m := tsHostRe.FindStringSubmatch(all); m != nil {
		host = m[1]
	}
	if strings.Contains(header, "MIA_GW") {
		id := sh.s.freeID()
		sh.out("==> Gateway Tailscale ("+host+") anunciando 10.0.10.0/24",
			"downloading http://download.proxmox.com/images/system/debian-13-standard_13.1-2_amd64.tar.zst to /var/lib/vz/template/cache/debian-13-standard_13.1-2_amd64.tar.zst")
		sh.sleep(700 * time.Millisecond)
		sh.out("  Logical volume \"vm-"+strconv.Itoa(id)+"-disk-0\" created.", "extracting archive ...", "Detected container architecture: amd64")
		sh.s.addGuest(&guest{vmid: id, name: host, kind: "lxc", node: sh.node, cores: 1, mem: gib / 2, disk: 4 * gib, memUse: 0.25, profile: idle(0.02), tags: "mia;tailscale"})
		sh.out("==> CT " + strconv.Itoa(id) + " criado, esperando a rede")
		sh.sleep(700 * time.Millisecond)
		sh.out("Installing Tailscale for debian trixie, using method apt", "+ apt-get install -y tailscale tailscale-archive-keyring", "Installation complete! Log in to start using Tailscale by running:", "", "tailscale up", "net.ipv4.ip_forward = 1", "net.ipv6.conf.all.forwarding = 1")
		sh.sleep(500 * time.Millisecond)
		sh.out("==> Pronto. Aprove a rota 10.0.10.0/24 em https://login.tailscale.com/admin/machines")
		return
	}
	port := "80"
	if m := tsPortRe.FindStringSubmatch(all); m != nil {
		port = m[1]
	}
	sh.out("==> Tailscale no CT "+host, "Installing Tailscale for debian trixie, using method apt")
	sh.sleep(800 * time.Millisecond)
	sh.out("Installation complete! Log in to start using Tailscale by running:", "", "tailscale up", "",
		"Available within your tailnet:", "", "https://"+host+".tail1a2b3c.ts.net/", "|-- proxy http://127.0.0.1:"+port, "")
}

func writeJSONRaw(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

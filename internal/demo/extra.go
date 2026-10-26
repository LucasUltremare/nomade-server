package demo

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Mais endpoints do PVE falso: config de guest (CPU/RAM/discos), migração,
// saúde (SMART, serviços, apt, certificados), jobs de backup, histórico de
// tasks e firewall.

func (s *Server) routesExtra(mux *http.ServeMux) {
	// Rotas de guest com lxc/qemu explícitos: com {kind} elas se sobreporiam
	// às de /nodes/{node}/firewall/rules/{pos} e o ServeMux recusa.
	for _, k := range []string{"lxc", "qemu"} {
		g := "/api2/json/nodes/{node}/" + k + "/{vmid}"
		mux.HandleFunc("GET "+g+"/config", s.auth(s.guestConfig))
		mux.HandleFunc("PUT "+g+"/config", s.auth(s.guestConfigPut))
		mux.HandleFunc("GET "+g+"/pending", s.auth(func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) }))
		mux.HandleFunc("PUT "+g+"/resize", s.auth(s.resize))
		mux.HandleFunc("POST "+g+"/migrate", s.auth(s.migrate))
	}
	mux.HandleFunc("POST /api2/json/nodes/{node}/lxc/{vmid}/move_volume", s.auth(s.moveDisk))
	mux.HandleFunc("POST /api2/json/nodes/{node}/qemu/{vmid}/move_disk", s.auth(s.moveDisk))

	mux.HandleFunc("GET /api2/json/nodes/{node}/disks/list", s.auth(s.diskList))
	mux.HandleFunc("GET /api2/json/nodes/{node}/services", s.auth(s.services))
	mux.HandleFunc("GET /api2/json/nodes/{node}/apt/update", s.auth(s.aptList))
	mux.HandleFunc("POST /api2/json/nodes/{node}/apt/update", s.auth(s.aptRefresh))
	mux.HandleFunc("GET /api2/json/nodes/{node}/certificates/info", s.auth(s.certs))

	mux.HandleFunc("GET /api2/json/cluster/backup", s.auth(s.jobList))
	mux.HandleFunc("POST /api2/json/cluster/backup", s.auth(s.jobCreate))
	mux.HandleFunc("PUT /api2/json/cluster/backup/{id}", s.auth(s.jobUpdate))
	mux.HandleFunc("DELETE /api2/json/cluster/backup/{id}", s.auth(s.jobDelete))
	mux.HandleFunc("GET /api2/json/cluster/backup-info/not-backed-up", s.auth(s.notBackedUp))

	mux.HandleFunc("GET /api2/json/cluster/tasks", s.auth(s.clusterTasks))
	mux.HandleFunc("DELETE /api2/json/nodes/{node}/tasks/{upid}", s.auth(s.taskStop))

	for _, base := range []string{"/api2/json/cluster/firewall", "/api2/json/nodes/{node}/firewall",
		"/api2/json/nodes/{node}/lxc/{vmid}/firewall", "/api2/json/nodes/{node}/qemu/{vmid}/firewall"} {
		mux.HandleFunc("GET "+base+"/options", s.auth(s.fwOptions))
		mux.HandleFunc("PUT "+base+"/options", s.auth(s.fwOptionsPut))
		mux.HandleFunc("GET "+base+"/rules", s.auth(s.fwRules))
		mux.HandleFunc("POST "+base+"/rules", s.auth(s.fwRuleAdd))
		mux.HandleFunc("PUT "+base+"/rules/{pos}", s.auth(s.fwRulePut))
		mux.HandleFunc("DELETE "+base+"/rules/{pos}", s.auth(s.fwRuleDelete))
	}
	mux.HandleFunc("GET /api2/json/cluster/firewall/macros", s.auth(func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{
			{"macro": "SSH", "descr": "Secure shell traffic"}, {"macro": "HTTP", "descr": "Hypertext Transfer Protocol (WWW)"},
			{"macro": "HTTPS", "descr": "Hypertext Transfer Protocol (WWW) over SSL"}, {"macro": "DNS", "descr": "Domain Name System traffic (upd and tcp)"},
			{"macro": "Ping", "descr": "ICMP echo request"}, {"macro": "SMB", "descr": "Microsoft SMB traffic"}, {"macro": "NFS", "descr": "Network File System traffic"},
		})
	}))
}

func (s *Server) initExtra() {
	s.confs = map[int]map[string]string{}
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day()+1, 1, 30, 0, 0, time.Local)
	s.jobs = []map[string]string{
		{"id": "backup-a1b2c3d4-e5f6", "schedule": "01:30", "storage": "nas-backup", "mode": "snapshot", "compress": "zstd",
			"all": "1", "exclude": "110", "enabled": "1", "prune-backups": "keep-daily=7,keep-weekly=4,keep-monthly=3",
			"comment": "Tudo, toda madrugada", "next-run": strconv.FormatInt(next.Unix(), 10)},
		{"id": "backup-9f8e7d6c-5b4a", "schedule": "*/6:00", "storage": "local", "mode": "snapshot", "compress": "zstd",
			"vmid": "103", "enabled": "0", "prune-backups": "keep-last=4", "comment": "Mundo do minecraft"},
	}
	s.fw = map[string]*fwState{
		"cluster": {opts: map[string]string{"enable": "0", "policy_in": "DROP", "policy_out": "ACCEPT"}, rules: []map[string]string{
			{"type": "in", "action": "ACCEPT", "macro": "SSH", "source": "lan", "enable": "1", "comment": "SSH da LAN"},
			{"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "8006", "source": "+management", "enable": "1", "comment": "Painel do Proxmox", "log": "info"},
		}},
		"node/pve-01": {opts: map[string]string{"enable": "1", "policy_in": "DROP", "policy_out": "ACCEPT"}, rules: []map[string]string{
			{"type": "in", "action": "ACCEPT", "macro": "Ping", "enable": "1", "comment": "Ping"},
			{"type": "in", "action": "DROP", "iface": "vmbr1", "source": "+iot", "enable": "1", "comment": "IoT não fala com o host", "log": "warning"},
			{"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "9100", "source": "10.0.10.11", "enable": "1", "comment": "node_exporter pro Grafana"},
			{"type": "in", "action": "REJECT", "proto": "udp", "dport": "5353", "enable": "0", "comment": "mDNS"},
			{"type": "out", "action": "ACCEPT", "macro": "DNS", "dest": "10.0.10.6", "enable": "1", "comment": "DNS pelo AdGuard"},
			{"type": "out", "action": "DROP", "dest": "+iot", "proto": "tcp", "dport": "22", "enable": "1", "comment": "Sem SSH pros IoT"},
		}},
		"guest/101": {opts: map[string]string{"enable": "1", "policy_in": "DROP", "policy_out": "ACCEPT"}, rules: []map[string]string{
			{"type": "in", "action": "ACCEPT", "proto": "tcp", "dport": "8096", "enable": "1", "comment": "Jellyfin web"},
		}},
	}
}

// ---------- config dos guests ----------

func diskStore(node string) string {
	if n := findNode(node); n != nil && n.pool == 0 {
		return "local-lvm"
	}
	return "tank"
}

// conf devolve (criando se preciso) o config do guest; chamar com s.mu travado.
func (s *Server) conf(g *guest) map[string]string {
	if c := s.confs[g.vmid]; c != nil {
		return c
	}
	st := diskStore(g.node)
	c := map[string]string{"cores": strconv.Itoa(g.cores), "memory": strconv.FormatInt(g.mem>>20, 10)}
	if g.tags != "" {
		c["tags"] = g.tags
	}
	gb := g.disk >> 30
	if g.kind == "lxc" {
		c["hostname"] = g.name
		c["swap"] = "512"
		c["rootfs"] = fmt.Sprintf("%s:subvol-%d-disk-0,size=%dG", st, g.vmid, gb)
		c["net0"] = fmt.Sprintf("name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:%02X:%02X,ip=dhcp,type=veth", g.vmid/256, g.vmid%256)
		c["onboot"] = "1"
		c["features"] = "nesting=1"
		c["unprivileged"] = "1"
		c["ostype"] = "debian"
		if g.vmid == 101 {
			c["mp0"] = fmt.Sprintf("%s:subvol-101-disk-1,mp=/media,size=500G,backup=0", st)
			c["mp1"] = "/tank/media,mp=/data/media"
		}
		if g.vmid == 114 {
			c["mp0"] = "/tank/media,mp=/media,ro=1"
			c["net1"] = "name=eth1,bridge=vmbr1,hwaddr=BC:24:11:00:00:72,ip=10.0.20.14/24,tag=20,type=veth"
		}
		if g.vmid == 101 {
			c["net1"] = "name=eth1,bridge=vmbr2,hwaddr=BC:24:11:00:00:65,ip=10.0.50.101/24,type=veth"
		}
	} else {
		c["name"] = g.name
		c["sockets"] = "1"
		c["scsi0"] = fmt.Sprintf("%s:vm-%d-disk-0,iothread=1,size=%dG,ssd=1", st, g.vmid, gb)
		c["ide2"] = "local:iso/debian-13.1.0-amd64-netinst.iso,media=cdrom"
		c["net0"] = fmt.Sprintf("virtio=BC:24:11:AA:%02X:%02X,bridge=vmbr0,firewall=1", g.vmid/256, g.vmid%256)
		c["ostype"], c["cpu"], c["boot"], c["scsihw"] = "l26", "host", "order=scsi0;ide2;net0", "virtio-scsi-single"
		if g.vmid == 102 || g.vmid == 107 {
			c["agent"] = "1"
		}
		if g.vmid == 110 {
			c["net0"] = fmt.Sprintf("e1000e=BC:24:11:AA:%02X:%02X,bridge=vmbr1,firewall=1", g.vmid/256, g.vmid%256)
		}
		if g.vmid == 107 {
			c["usb0"] = "host=1a86:55d4"
		}
	}
	s.confs[g.vmid] = c
	return c
}

func (s *Server) guestByPath(r *http.Request) *guest {
	vmid, _ := strconv.Atoi(r.PathValue("vmid"))
	for _, g := range s.list {
		if g.vmid == vmid {
			return g
		}
	}
	return nil
}

func (s *Server) guestConfig(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.guestByPath(r)
	if g == nil {
		fail(w, 500, "Configuration file does not exist")
		return
	}
	out := map[string]any{"digest": token()}
	for k, v := range s.conf(g) {
		out[k] = v
	}
	reply(w, out)
}

var newDiskRe = regexp.MustCompile(`^([a-z0-9-]+):(\d+)(,.*)?$`)

func (s *Server) guestConfigPut(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.guestByPath(r)
	if g == nil {
		fail(w, 500, "Configuration file does not exist")
		return
	}
	c := s.conf(g)
	for k, vals := range r.PostForm {
		v := vals[0]
		switch {
		case k == "delete":
			for _, key := range strings.Split(v, ",") {
				old, ok := c[key]
				if !ok {
					continue
				}
				delete(c, key)
				if !strings.HasPrefix(key, "unused") {
					// Disco desanexado vira unusedN (só o volume).
					vol := strings.SplitN(old, ",", 2)[0]
					for i := 0; ; i++ {
						if _, used := c[fmt.Sprintf("unused%d", i)]; !used {
							c[fmt.Sprintf("unused%d", i)] = vol
							break
						}
					}
				}
			}
		case k == "cores":
			c[k] = v
			g.cores, _ = strconv.Atoi(v)
		case k == "memory":
			c[k] = v
			mb, _ := strconv.Atoi(v)
			g.mem = int64(mb) << 20
		case (strings.HasPrefix(k, "mp") || strings.HasPrefix(k, "scsi") || strings.HasPrefix(k, "sata")) &&
			(strings.Contains(v, "-disk-") || strings.HasPrefix(v, "/")):
			c[k] = v // disco existente com opções novas (ou bind mount)
		case strings.HasPrefix(k, "mp") || strings.HasPrefix(k, "scsi"):
			m := newDiskRe.FindStringSubmatch(v)
			if m == nil {
				fail(w, 400, "invalid format for "+k)
				return
			}
			n := 1
			for _, x := range c {
				if strings.Contains(x, fmt.Sprintf("-%d-disk-", g.vmid)) {
					n++
				}
			}
			kind := "subvol"
			if g.kind == "qemu" {
				kind = "vm"
			}
			c[k] = fmt.Sprintf("%s:%s-%d-disk-%d,size=%sG%s", m[1], kind, g.vmid, n, m[2], m[3])
		default:
			c[k] = v
		}
	}
	reply(w, nil)
}

var sizeOptRe = regexp.MustCompile(`size=(\d+)G`)

func (s *Server) resize(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	disk, size := r.PostForm.Get("disk"), r.PostForm.Get("size")
	add, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(size, "+"), "G"))
	if err != nil || !strings.HasPrefix(size, "+") {
		fail(w, 400, "shrinking disks is not supported")
		return
	}
	s.mu.Lock()
	g := s.guestByPath(r)
	if g == nil {
		s.mu.Unlock()
		fail(w, 500, "no such guest")
		return
	}
	c := s.conf(g)
	v, ok := c[disk]
	if !ok {
		s.mu.Unlock()
		fail(w, 400, "unable to parse volume ID '"+disk+"'")
		return
	}
	cur := 0
	if m := sizeOptRe.FindStringSubmatch(v); m != nil {
		cur, _ = strconv.Atoi(m[1])
	}
	c[disk] = sizeOptRe.ReplaceAllString(v, fmt.Sprintf("size=%dG", cur+add))
	if disk == "rootfs" || disk == "scsi0" {
		g.disk += int64(add) << 30
	}
	s.mu.Unlock()
	reply(w, s.newTask(r.PathValue("node"), "resize", r.PathValue("vmid"), time.Second,
		[]string{fmt.Sprintf("Resizing image '%s' to %dG", disk, cur+add), "resize2fs 1.47.2 (1-Jan-2025)", "The filesystem is now resized."}, nil))
}

func (s *Server) moveDisk(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	disk := r.PostForm.Get("volume") + r.PostForm.Get("disk")
	target := r.PostForm.Get("storage")
	s.mu.Lock()
	g := s.guestByPath(r)
	if g == nil {
		s.mu.Unlock()
		fail(w, 500, "no such guest")
		return
	}
	if g.kind == "lxc" && s.status[g.vmid] == "running" {
		s.mu.Unlock()
		fail(w, 500, "cannot move volumes of a running container")
		return
	}
	c := s.conf(g)
	v, ok := c[disk]
	if !ok {
		s.mu.Unlock()
		fail(w, 400, "no such volume '"+disk+"'")
		return
	}
	_, rest, _ := strings.Cut(v, ":")
	c[disk] = target + ":" + rest
	s.mu.Unlock()
	reply(w, s.newTask(r.PathValue("node"), "move_volume", r.PathValue("vmid"), 4*time.Second,
		[]string{"moving volume '" + disk + "' to storage '" + target + "'", "copied 25%", "copied 61%", "copied 100%", "removing old volume"}, nil))
}

func (s *Server) migrate(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	target := r.PostForm.Get("target")
	if findNode(target) == nil {
		fail(w, 400, "no such node '"+target+"'")
		return
	}
	s.mu.Lock()
	g := s.guestByPath(r)
	s.mu.Unlock()
	if g == nil {
		fail(w, 500, "no such guest")
		return
	}
	from := g.node
	typ := "qmigrate"
	lines := []string{"starting migration of VM " + strconv.Itoa(g.vmid) + " to node '" + target + "'",
		"found local disk '" + diskStore(from) + ":vm-" + strconv.Itoa(g.vmid) + "-disk-0' (attached)",
		"starting VM on remote node", "migration status: active (transferred 1.2 GiB of 4.0 GiB)", "migration status: completed", "migration finished successfully"}
	if g.kind == "lxc" {
		typ = "vzmigrate"
		lines = []string{"shutdown CT " + strconv.Itoa(g.vmid), "starting migration of CT " + strconv.Itoa(g.vmid) + " to node '" + target + "'",
			"volume '" + diskStore(from) + ":subvol-" + strconv.Itoa(g.vmid) + "-disk-0' is on local storage; copying", "start final cleanup", "start container on target node", "migration finished successfully"}
	}
	reply(w, s.newTask(from, typ, strconv.Itoa(g.vmid), 5*time.Second, lines, func() {
		s.mu.Lock()
		g.node = target
		if c := s.confs[g.vmid]; c != nil {
			st := diskStore(target)
			for k, v := range c {
				if i := strings.Index(v, ":"); i > 0 && (k == "rootfs" || strings.HasPrefix(k, "mp") || strings.HasPrefix(k, "scsi")) {
					c[k] = st + v[i:]
				}
			}
		}
		s.mu.Unlock()
	}))
}

// ---------- saúde ----------

func (s *Server) diskList(w http.ResponseWriter, r *http.Request) {
	disks := map[string][]map[string]any{
		"pve-01": {
			{"devpath": "/dev/nvme0n1", "model": "Samsung SSD 980 PRO 1TB", "type": "nvme", "size": int64(1e12), "health": "PASSED", "wearout": 96, "used": "ZFS"},
			{"devpath": "/dev/sda", "model": "WDC WD80EFZZ-68BTXN0", "type": "hdd", "size": int64(8e12), "health": "PASSED", "wearout": "N/A", "used": "ZFS"},
			{"devpath": "/dev/sdb", "model": "WDC WD80EFZZ-68BTXN0", "type": "hdd", "size": int64(8e12), "health": "PASSED", "wearout": "N/A", "used": "ZFS"},
		},
		"pve-02": {
			{"devpath": "/dev/nvme0n1", "model": "CT1000P3SSD8", "type": "nvme", "size": int64(1e12), "health": "PASSED", "wearout": 16, "used": "ZFS"},
			{"devpath": "/dev/sda", "model": "ST4000VN006-3CW104", "type": "hdd", "size": int64(4e12), "health": "PASSED", "wearout": "N/A", "used": "ZFS"},
		},
		"pve-03": {
			{"devpath": "/dev/sda", "model": "KINGSTON SA400S37240G", "type": "ssd", "size": int64(240e9), "health": "PASSED", "wearout": 71, "used": "LVM"},
		},
	}
	reply(w, disks[r.PathValue("node")])
}

func (s *Server) services(w http.ResponseWriter, r *http.Request) {
	out := []map[string]string{}
	for _, n := range []string{"pveproxy", "pvedaemon", "pvestatd", "pve-cluster", "corosync", "pve-firewall", "pvescheduler", "chrony", "cron", "postfix", "sshd"} {
		out = append(out, map[string]string{"name": n, "service": n, "state": "running", "unit-state": "enabled", "desc": n + " service"})
	}
	reply(w, out)
}

func (s *Server) aptList(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("node") != "pve-01" {
		reply(w, []any{})
		return
	}
	reply(w, []map[string]string{
		{"Package": "pve-manager", "Version": "9.0.10", "OldVersion": "9.0.6", "Title": "Proxmox Virtual Environment Management Tools"},
		{"Package": "proxmox-kernel-6.14", "Version": "6.14.11-1", "OldVersion": "6.14.8-2", "Title": "Latest Proxmox Kernel Image"},
		{"Package": "libpve-common-perl", "Version": "9.0.11", "OldVersion": "9.0.9", "Title": "Proxmox VE base library"},
	})
}

func (s *Server) aptRefresh(w http.ResponseWriter, r *http.Request) {
	reply(w, s.newTask(r.PathValue("node"), "aptupdate", "", 3*time.Second, []string{
		"starting apt-get update", "Hit:1 http://deb.debian.org/debian trixie InRelease",
		"Hit:2 http://download.proxmox.com/debian/pve trixie InRelease", "Reading package lists...", "TASK OK"}, nil))
}

func (s *Server) certs(w http.ResponseWriter, r *http.Request) {
	n := r.PathValue("node")
	out := []map[string]any{
		{"filename": "pve-root-ca.pem", "subject": "/CN=Proxmox Virtual Environment", "notafter": time.Now().AddDate(8, 0, 0).Unix()},
		{"filename": "pve-ssl.pem", "subject": "/CN=" + n + ".lan", "notafter": time.Now().AddDate(1, 2, 0).Unix()},
	}
	if n == "pve-03" {
		out = append(out, map[string]any{"filename": "pveproxy-ssl.pem", "subject": "/CN=pve-03.homelab.nomade.builders", "notafter": time.Now().AddDate(0, 0, 12).Unix()})
	}
	reply(w, out)
}

// ---------- jobs de backup ----------

func (s *Server) jobList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, j := range s.jobs {
		row := map[string]any{"type": "vzdump"}
		for k, v := range j {
			row[k] = v
		}
		out = append(out, row)
	}
	reply(w, out)
}

func applyJob(j map[string]string, r *http.Request) {
	r.ParseForm()
	for k, vals := range r.PostForm {
		if k == "delete" {
			for _, d := range strings.Split(vals[0], ",") {
				delete(j, d)
			}
			continue
		}
		j[k] = vals[0]
	}
	if j["all"] == "0" {
		delete(j, "all")
	}
}

func (s *Server) jobCreate(w http.ResponseWriter, r *http.Request) {
	j := map[string]string{"id": "backup-" + token()[:12]}
	applyJob(j, r)
	s.mu.Lock()
	s.jobs = append(s.jobs, j)
	s.mu.Unlock()
	reply(w, nil)
}

func (s *Server) jobUpdate(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, j := range s.jobs {
		if j["id"] == r.PathValue("id") {
			applyJob(j, r)
			reply(w, nil)
			return
		}
	}
	fail(w, 404, "job not found")
}

func (s *Server) jobDelete(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs = slices.DeleteFunc(s.jobs, func(j map[string]string) bool { return j["id"] == r.PathValue("id") })
	reply(w, nil)
}

func (s *Server) notBackedUp(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, g := range s.list {
		if g.template {
			continue
		}
		covered := false
		for _, j := range s.jobs {
			id := strconv.Itoa(g.vmid)
			if j["all"] == "1" && !slices.Contains(strings.Split(j["exclude"], ","), id) {
				covered = true
			}
			if slices.Contains(strings.Split(j["vmid"], ","), id) {
				covered = true
			}
		}
		if !covered {
			out = append(out, map[string]any{"vmid": g.vmid, "name": g.name, "type": g.kind})
		}
	}
	reply(w, out)
}

// ---------- tasks ----------

func (s *Server) clusterTasks(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	out := []map[string]any{}
	add := func(node, typ, id, status string, start, end time.Time) {
		row := map[string]any{"upid": fmt.Sprintf("UPID:%s:%08X:%08X:%08X:%s:%s:root@pam:", node, start.Unix()%0xFFFFFF, start.Unix()%0xFFFF, start.Unix(), typ, id),
			"node": node, "type": typ, "id": id, "user": "root@pam", "starttime": start.Unix()}
		if !end.IsZero() {
			row["endtime"], row["status"] = end.Unix(), status
		}
		out = append(out, row)
	}
	day := now.Truncate(24 * time.Hour)
	for d := 0; d < 2; d++ {
		for _, n := range nodes {
			for _, j := range backupJobs[n.name] {
				st := day.Add(-time.Duration(d) * 24 * time.Hour).Add(time.Duration(j[0] * float64(time.Hour)))
				if st.After(now) {
					continue
				}
				status := "OK"
				if n.name == "pve-03" && d == 1 {
					status = "job errors"
				}
				add(n.name, "vzdump", "", status, st, st.Add(time.Duration(j[1]*float64(time.Hour))))
			}
		}
	}
	add("pve-01", "vzstart", "114", "OK", now.Add(-5*time.Hour), now.Add(-5*time.Hour+3*time.Second))
	add("pve-02", "qmstart", "107", "OK", now.Add(-26*time.Hour), now.Add(-26*time.Hour+9*time.Second))
	add("pve-02", "aptupdate", "", "OK", now.Add(-20*time.Hour), now.Add(-20*time.Hour+40*time.Second))
	s.mu.Lock()
	for upid, t := range s.tasksBy {
		if t.typ == "vncshell" {
			continue
		}
		row := map[string]any{"upid": upid, "node": t.node, "type": t.typ, "id": t.id, "user": "root@pam", "starttime": t.start.Unix()}
		if time.Since(t.start) >= t.dur {
			row["endtime"], row["status"] = t.start.Add(t.dur).Unix(), t.exit
		}
		out = append(out, row)
	}
	s.mu.Unlock()
	reply(w, out)
}

func (s *Server) taskStop(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.tasksBy[r.PathValue("upid")]; t != nil && time.Since(t.start) < t.dur {
		t.dur = time.Since(t.start)
		t.exit = "interrupted by signal"
		t.lines = append(t.lines, "received interrupt")
	}
	reply(w, nil)
}

// ---------- firewall ----------

type fwState struct {
	opts  map[string]string
	rules []map[string]string
}

func (s *Server) fwFor(r *http.Request) *fwState {
	key := "cluster"
	switch {
	case r.PathValue("vmid") != "":
		key = "guest/" + r.PathValue("vmid")
	case r.PathValue("node") != "":
		key = "node/" + r.PathValue("node")
	}
	st := s.fw[key]
	if st == nil {
		enable := "0"
		if strings.HasPrefix(key, "node/") {
			enable = "1"
		}
		st = &fwState{opts: map[string]string{"enable": enable, "policy_in": "DROP", "policy_out": "ACCEPT"}}
		s.fw[key] = st
	}
	return st
}

func (s *Server) fwOptions(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	reply(w, s.fwFor(r).opts)
}

func (s *Server) fwOptionsPut(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.fwFor(r)
	for k, v := range r.PostForm {
		st.opts[k] = v[0]
	}
	reply(w, nil)
}

func (s *Server) fwRules(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for i, rule := range s.fwFor(r).rules {
		row := map[string]any{"pos": i}
		for k, v := range rule {
			if k == "enable" {
				row[k], _ = strconv.Atoi(v)
				continue
			}
			row[k] = v
		}
		out = append(out, row)
	}
	reply(w, out)
}

func (s *Server) fwRuleAdd(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	rule := map[string]string{}
	for k, v := range r.PostForm {
		rule[k] = v[0]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.fwFor(r)
	// Regra nova entra no topo, como no PVE.
	st.rules = append([]map[string]string{rule}, st.rules...)
	reply(w, nil)
}

func (s *Server) fwRulePut(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	pos, _ := strconv.Atoi(r.PathValue("pos"))
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.fwFor(r)
	if pos < 0 || pos >= len(st.rules) {
		fail(w, 400, "no rule at position "+r.PathValue("pos"))
		return
	}
	if to := r.PostForm.Get("moveto"); to != "" {
		// Como o PVE: a regra vai pra antes da que está em "moveto".
		dst, _ := strconv.Atoi(to)
		rule := st.rules[pos]
		st.rules = slices.Delete(st.rules, pos, pos+1)
		if dst > pos {
			dst--
		}
		st.rules = slices.Insert(st.rules, min(max(dst, 0), len(st.rules)), rule)
		reply(w, nil)
		return
	}
	for _, k := range strings.Split(r.PostForm.Get("delete"), ",") {
		delete(st.rules[pos], k)
	}
	for k, v := range r.PostForm {
		if k != "delete" && k != "digest" {
			st.rules[pos][k] = v[0]
		}
	}
	reply(w, nil)
}

func (s *Server) fwRuleDelete(w http.ResponseWriter, r *http.Request) {
	pos, _ := strconv.Atoi(r.PathValue("pos"))
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.fwFor(r)
	if pos < 0 || pos >= len(st.rules) {
		fail(w, 400, "no rule at position "+r.PathValue("pos"))
		return
	}
	st.rules = slices.Delete(st.rules, pos, pos+1)
	reply(w, nil)
}

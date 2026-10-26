package demo

import (
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

// Endpoints do PVE falso que não são coleções simples: objetos por nó
// (DNS, hora, hosts, config), logs, SMART, criação de discos, ACL, pools,
// status do HA, cluster, ACME, notificações, SDN, Ceph, monitor, assinatura.

func (s *Server) routesSpecial(mux *http.ServeMux) {
	j := "/api2/json"
	h := func(pattern string, fn http.HandlerFunc) {
		method, path, _ := strings.Cut(pattern, " ")
		mux.HandleFunc(method+" "+j+path, s.auth(fn))
	}
	// Objetos por nó.
	h("GET /nodes/{node}/dns", s.nodeObj("dns"))
	h("PUT /nodes/{node}/dns", s.nodeObjPut("dns"))
	h("GET /nodes/{node}/time", s.nodeObj("time"))
	h("PUT /nodes/{node}/time", s.nodeObjPut("time"))
	h("GET /nodes/{node}/config", s.nodeObj("config"))
	h("PUT /nodes/{node}/config", s.nodeObjPut("config"))
	h("GET /nodes/{node}/hosts", s.nodeObj("hosts"))
	h("POST /nodes/{node}/hosts", s.nodeObjPut("hosts"))
	h("POST /nodes/{node}/wakeonlan", func(w http.ResponseWriter, r *http.Request) { reply(w, "bc:24:11:00:00:01") })
	h("GET /nodes/{node}/journal", s.journal)
	h("GET /cluster/log", s.clusterLog)
	h("GET /nodes/{node}/firewall/log", s.firewallLog)

	// Discos.
	h("GET /nodes/{node}/disks/smart", s.smart)
	h("PUT /nodes/{node}/disks/wipedisk", s.diskTask("wipedisk", "wiping disk"))
	h("POST /nodes/{node}/disks/initgpt", s.diskTask("diskinit", "initializing GPT"))
	h("POST /nodes/{node}/disks/zfs", s.diskTask("zfscreate", "creating zpool"))
	h("POST /nodes/{node}/disks/lvm", s.diskTask("lvmcreate", "creating volume group"))
	h("POST /nodes/{node}/disks/lvmthin", s.diskTask("lvmthincreate", "creating thin pool"))
	h("POST /nodes/{node}/disks/directory", s.diskTask("dircreate", "creating directory storage"))
	h("GET /nodes/{node}/disks/lvm", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"leaf": 0, "children": []map[string]any{{"name": "pve", "size": int64(240e9), "free": int64(16e9), "leaf": 0}}})
	})
	h("GET /nodes/{node}/disks/lvmthin", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"lv": "data", "vg": "pve", "lv_size": int64(180e9), "used": int64(62e9), "metadata_size": int64(1e9), "metadata_used": int64(1e8)}})
	})
	h("GET /nodes/{node}/disks/directory", func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) })
	h("GET /nodes/{node}/disks/zfs/{name}", s.zfsDetail)

	// Storage: scan e importação.
	h("GET /nodes/{node}/scan/nfs", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"path": "/mnt/tank/backups", "options": "10.0.10.0/24"}, {"path": "/mnt/tank/media", "options": "10.0.10.0/24"}})
	})
	h("GET /nodes/{node}/scan/cifs", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"share": "media", "description": "Filmes e séries"}, {"share": "backups", "description": ""}})
	})
	h("GET /nodes/{node}/scan/pbs", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"store": "homelab", "comment": "Datastore principal"}})
	})
	h("GET /nodes/{node}/scan/zfs", func(w http.ResponseWriter, r *http.Request) { reply(w, []map[string]string{{"pool": "tank"}}) })
	h("GET /nodes/{node}/scan/lvm", func(w http.ResponseWriter, r *http.Request) { reply(w, []map[string]string{{"vg": "pve"}}) })
	h("GET /nodes/{node}/scan/lvmthin", func(w http.ResponseWriter, r *http.Request) { reply(w, []map[string]string{{"lv": "data"}}) })
	h("GET /nodes/{node}/storage/{storage}/import-metadata", s.importMeta)

	// Certificados.
	h("POST /nodes/{node}/certificates/custom", func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) })
	h("DELETE /nodes/{node}/certificates/custom", func(w http.ResponseWriter, r *http.Request) { reply(w, nil) })
	h("POST /nodes/{node}/certificates/acme/certificate", s.diskTask("acmenewcert", "ordering certificate from Let's Encrypt"))
	h("PUT /nodes/{node}/certificates/acme/certificate", s.diskTask("acmerenew", "renewing certificate"))

	// Permissões e pools.
	h("GET /access/acl", s.aclList)
	h("PUT /access/acl", s.aclPut)
	h("GET /access/permissions", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"/": map[string]int{"Sys.Audit": 1, "VM.Allocate": 1, "Datastore.Allocate": 1, "Permissions.Modify": 1}})
	})
	h("GET /access/tfa", s.tfaList)
	h("POST /access/tfa/{userid}", s.tfaAdd)
	h("DELETE /access/tfa/{userid}/{id}", s.tfaDelete)
	h("GET /pools", s.poolList)
	h("POST /pools", s.poolCreate)
	h("PUT /pools", s.poolUpdate)
	h("DELETE /pools", s.poolDelete)

	// HA, replicação, cluster.
	h("GET /cluster/ha/status/current", s.haStatus)
	h("GET /nodes/{node}/replication", s.replStatus)
	h("POST /nodes/{node}/replication/{id}/schedule_now", func(w http.ResponseWriter, r *http.Request) { reply(w, nil) })
	h("GET /nodes/{node}/replication/{id}/log", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"n": 1, "t": "start replication job"}, {"n": 2, "t": "guest => CT 103, running => 1"}, {"n": 3, "t": "end replication job"}})
	})
	h("GET /cluster/config/nodes", func(w http.ResponseWriter, r *http.Request) {
		out := []map[string]any{}
		for i, n := range nodes {
			out = append(out, map[string]any{"node": n.name, "nodeid": i + 1, "quorum_votes": 1, "ring0_addr": n.ip})
		}
		reply(w, out)
	})
	h("GET /cluster/config/join", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"preferred_node": "pve-01", "config_digest": token(), "totem": map[string]any{"cluster_name": "homelab", "version": 7},
			"nodelist": []map[string]any{{"name": "pve-01", "pve_addr": "10.0.10.11", "pve_fp": "4E:0B:…:D2:7A", "ring0_addr": "10.0.10.11"}}})
	})
	h("GET /cluster/config/totem", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"cluster_name": "homelab", "config_version": 7, "ip_version": "ipv4-6", "link_mode": "passive", "secauth": "on", "version": 2})
	})
	h("POST /cluster/config", func(w http.ResponseWriter, r *http.Request) {
		fail(w, 500, "cluster config '/etc/pve/corosync.conf' already exists")
	})
	h("POST /cluster/config/join", func(w http.ResponseWriter, r *http.Request) {
		fail(w, 500, "this host already contains virtual guests")
	})
	h("GET /cluster/options", s.clusterOptions)
	h("PUT /cluster/options", s.clusterOptionsPut)

	// ACME.
	h("GET /cluster/acme/directories", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"name": "Let's Encrypt V2", "url": "https://acme-v02.api.letsencrypt.org/directory"},
			{"name": "Let's Encrypt V2 Staging", "url": "https://acme-staging-v02.api.letsencrypt.org/directory"}})
	})
	h("GET /cluster/acme/tos", func(w http.ResponseWriter, r *http.Request) {
		reply(w, "https://letsencrypt.org/documents/LE-SA-v1.5-February-24-2025.pdf")
	})
	h("GET /cluster/acme/challenge-schema", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"id": "cf", "name": "Cloudflare", "type": "dns", "schema": map[string]any{"fields": map[string]any{"CF_Token": map[string]string{"type": "string"}, "CF_Account_ID": map[string]string{"type": "string"}}}},
			{"id": "duckdns", "name": "DuckDNS", "type": "dns"}, {"id": "standalone", "name": "HTTP (porta 80)", "type": "standalone"}})
	})

	// Notificações.
	h("GET /cluster/notifications/targets", s.notifTargets)
	h("POST /cluster/notifications/targets/{name}/test", func(w http.ResponseWriter, r *http.Request) { reply(w, nil) })
	h("GET /cluster/notifications/matcher-fields", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"name": "type"}, {"name": "hostname"}, {"name": "job-id"}})
	})

	// SDN.
	h("GET /cluster/sdn", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"id": "zones"}, {"id": "vnets"}, {"id": "controllers"}, {"id": "ipams"}, {"id": "dns"}})
	})
	h("PUT /cluster/sdn", s.diskTask("reloadnetworkall", "applying SDN configuration on all nodes"))
	h("GET /cluster/sdn/controllers", func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) })
	h("GET /cluster/sdn/ipams", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]string{{"ipam": "pve", "type": "pve"}})
	})
	h("GET /cluster/sdn/dns", func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) })

	// Ceph: não instalado no demo, a menos que MIA_DEMO_CEPH=1 (pra ver as telas do Ceph).
	if os.Getenv("MIA_DEMO_CEPH") == "1" {
		s.cephRoutes(h)
	} else {
		notCeph := func(w http.ResponseWriter, r *http.Request) {
			fail(w, 500, "binary not installed: /usr/bin/ceph-mon")
		}
		h("GET /cluster/ceph/status", notCeph)
		for _, p := range []string{"status", "osd", "mon", "mgr", "pool", "fs", "mds"} {
			h("GET /nodes/{node}/ceph/"+p, notCeph)
		}
		h("POST /nodes/{node}/ceph/init", notCeph)
	}

	// Monitor do QEMU, cloud-init, assinatura.
	h("POST /nodes/{node}/qemu/{vmid}/monitor", s.monitor)
	h("GET /nodes/{node}/qemu/{vmid}/cloudinit", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"key": "ciuser", "value": "debian"}, {"key": "ipconfig0", "value": "ip=dhcp"}})
	})
	h("PUT /nodes/{node}/qemu/{vmid}/cloudinit", func(w http.ResponseWriter, r *http.Request) { reply(w, nil) })
	h("GET /nodes/{node}/subscription", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"status": "notfound", "message": "There is no subscription key", "url": "https://www.proxmox.com/en/proxmox-virtual-environment/pricing"})
	})
	h("PUT /nodes/{node}/subscription", func(w http.ResponseWriter, r *http.Request) {
		fail(w, 400, "invalid subscription key format")
	})

	// O resto cai no emulador REST.
	mux.HandleFunc(j+"/", s.auth(func(w http.ResponseWriter, r *http.Request) {
		if s.rest.handle(w, r, strings.TrimPrefix(r.URL.EscapedPath(), j)) {
			return
		}
		fail(w, 501, "not implemented in the Mia demo: "+r.Method+" "+r.URL.Path)
	}))
}

// ---------- objetos por nó ----------

func (s *Server) nodeObjects(node string) map[string]map[string]any {
	if s.objs == nil {
		s.objs = map[string]map[string]map[string]any{}
	}
	if s.objs[node] == nil {
		n := findNode(node)
		ip := "10.0.10.10"
		if n != nil {
			ip = n.ip
		}
		s.objs[node] = map[string]map[string]any{
			"dns":    {"search": "lan", "dns1": "10.0.10.1", "dns2": "1.1.1.1"},
			"time":   {"timezone": "America/Sao_Paulo", "time": time.Now().Unix(), "localtime": time.Now().Unix()},
			"config": {"description": "", "wakeonlan": "bc:24:11:00:00:01", "digest": token()},
			"hosts":  {"data": "127.0.0.1 localhost.localdomain localhost\n" + ip + " " + node + ".lan " + node + "\n\n::1 ip6-localhost ip6-loopback\n", "digest": token()},
		}
	}
	return s.objs[node]
}

func (s *Server) nodeObj(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		o := s.nodeObjects(r.PathValue("node"))[kind]
		if kind == "time" {
			o["time"], o["localtime"] = time.Now().Unix(), time.Now().Unix()
		}
		reply(w, o)
	}
}

func (s *Server) nodeObjPut(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		s.mu.Lock()
		defer s.mu.Unlock()
		o := s.nodeObjects(r.PathValue("node"))[kind]
		for k, vs := range r.PostForm {
			switch k {
			case "delete":
				for _, d := range strings.Split(vs[0], ",") {
					delete(o, d)
				}
			case "digest":
			default:
				o[k] = vs[0]
			}
		}
		o["digest"] = token()
		reply(w, nil)
	}
}

func (s *Server) journal(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	node := r.PathValue("node")
	msgs := []string{
		"pvedaemon[1432]: <root@pam> successful auth for user 'root@pam'",
		"pveproxy[2201]: worker 2208 finished",
		"pvestatd[1390]: status update time (0.142 seconds)",
		"systemd[1]: Started session-42.scope - Session 42 of User root.",
		"kernel: vmbr0: port 3(veth101i0) entered forwarding state",
		"pve-firewall[1376]: status update time (0.028 seconds)",
		"chronyd[912]: Selected source 200.160.7.186 (a.st1.ntp.br)",
		"smartd[880]: Device: /dev/sda [SAT], SMART Usage Attribute: 194 Temperature_Celsius changed from 64 to 63",
		"pvescheduler[3011]: starting task UPID:" + node + ":0000BC1A:vzdump::root@pam:",
		"zed[1102]: eid=41 class=scrub_finish pool='tank'",
	}
	out := []string{}
	for i := 0; i < 200; i++ {
		t := now.Add(-time.Duration(200-i) * 37 * time.Second)
		out = append(out, t.Format("Jan 02 15:04:05")+" "+node+" "+msgs[i%len(msgs)])
	}
	reply(w, out)
}

func (s *Server) clusterLog(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	out := []map[string]any{}
	for i, m := range []string{"successful auth for user 'root@pam'", "starting task UPID:pve-01:vzdump", "end task UPID:pve-01:vzdump OK",
		"successful auth for user 'ana@pve'", "starting task UPID:pve-02:qmstart:107", "update config of CT 101"} {
		out = append(out, map[string]any{"uid": i, "time": now.Add(-time.Duration(i) * 17 * time.Minute).Unix(), "node": nodes[i%3].name,
			"user": "root@pam", "tag": "pvedaemon", "pri": 6, "msg": m})
	}
	reply(w, out)
}

func (s *Server) firewallLog(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for i := 0; i < 20; i++ {
		out = append(out, map[string]any{"n": i + 1, "t": fmt.Sprintf("101 6 tap101i0-IN %s policy DROP: IN=fwbr101i0 SRC=203.0.113.%d DST=10.0.10.121 PROTO=TCP SPT=%d DPT=22",
			time.Now().Add(-time.Duration(20-i)*time.Minute).Format("02/Jan/2006:15:04:05 -0300"), 10+i, 40000+i)})
	}
	reply(w, out)
}

// ---------- discos ----------

func (s *Server) smart(w http.ResponseWriter, r *http.Request) {
	disk := r.URL.Query().Get("disk")
	if strings.Contains(disk, "nvme") {
		reply(w, map[string]any{"health": "PASSED", "type": "text", "text": "SMART/Health Information (NVMe Log 0x02)\nCritical Warning:                   0x00\nTemperature:                        41 Celsius\nAvailable Spare:                    100%\nPercentage Used:                    4%\nData Units Read:                    41,221,880 [21.1 TB]\nData Units Written:                 38,902,112 [19.9 TB]\nPower On Hours:                     11,042\nUnsafe Shutdowns:                   18\nMedia and Data Integrity Errors:    0"})
		return
	}
	attr := func(id int, name string, value, worst, thresh int, raw string) map[string]any {
		return map[string]any{"id": fmt.Sprintf("%3d", id), "name": name, "value": value, "worst": worst, "threshold": thresh, "raw": raw, "flags": "PO--CK", "fail": "-"}
	}
	reply(w, map[string]any{"health": "PASSED", "type": "ata", "attributes": []map[string]any{
		attr(1, "Raw_Read_Error_Rate", 200, 200, 51, "0"), attr(5, "Reallocated_Sector_Ct", 200, 200, 140, "0"),
		attr(9, "Power_On_Hours", 87, 87, 0, "9874"), attr(12, "Power_Cycle_Count", 100, 100, 0, "41"),
		attr(194, "Temperature_Celsius", 117, 105, 0, "33"), attr(197, "Current_Pending_Sector", 200, 200, 0, "0"),
		attr(199, "UDMA_CRC_Error_Count", 200, 200, 0, "0"),
	}})
}

func (s *Server) diskTask(typ, line string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		what := r.PostForm.Get("disk") + r.PostForm.Get("name") + r.PostForm.Get("device")
		reply(w, s.newTask(r.PathValue("node"), typ, "", 3*time.Second, []string{line + " " + what, "done"}, nil))
	}
}

func (s *Server) zfsDetail(w http.ResponseWriter, r *http.Request) {
	reply(w, map[string]any{"name": r.PathValue("name"), "state": "ONLINE", "errors": "No known data errors",
		"scan": "scrub repaired 0B in 03:12:44 with 0 errors on Sun Oct 12 03:36:45 2026",
		"children": []map[string]any{{"name": "mirror-0", "state": "ONLINE", "read": 0, "write": 0, "cksum": 0, "leaf": 0,
			"children": []map[string]any{{"name": "sda", "state": "ONLINE", "read": 0, "write": 0, "cksum": 0, "leaf": 1},
				{"name": "sdb", "state": "ONLINE", "read": 0, "write": 0, "cksum": 0, "leaf": 1}}}}})
}

func (s *Server) importMeta(w http.ResponseWriter, r *http.Request) {
	reply(w, map[string]any{"type": "vm", "source": "ova",
		"create-args": map[string]any{"name": "appliance", "cores": 2, "memory": 2048, "ostype": "l26"},
		"disks":       map[string]string{"scsi0": r.URL.Query().Get("volume") + "/disk-1.vmdk"},
		"net":         map[string]any{"net0": map[string]string{"model": "vmxnet3"}}, "warnings": []any{}})
}

// ---------- ACL, TFA, pools ----------

func (s *Server) aclList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acl == nil {
		s.acl = []map[string]any{
			{"path": "/", "type": "user", "ugid": "root@pam", "roleid": "Administrator", "propagate": 1},
			{"path": "/", "type": "group", "ugid": "admins", "roleid": "Administrator", "propagate": 1},
			{"path": "/vms/101", "type": "user", "ugid": "familia@pve", "roleid": "PVEVMUser", "propagate": 1},
			{"path": "/", "type": "user", "ugid": "mia@pve", "roleid": "MiaJobs", "propagate": 1},
		}
	}
	reply(w, s.acl)
}

func (s *Server) aclPut(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := r.PostForm
	s.mu.Lock()
	defer s.mu.Unlock()
	path, del := f.Get("path"), f.Get("delete") == "1"
	prop := 1
	if f.Get("propagate") == "0" {
		prop = 0
	}
	for _, role := range strings.Split(f.Get("roles"), ",") {
		for kind, ids := range map[string]string{"user": f.Get("users"), "group": f.Get("groups"), "token": f.Get("tokens")} {
			for _, id := range strings.Split(ids, ",") {
				if id == "" || role == "" {
					continue
				}
				s.acl = slices.DeleteFunc(s.acl, func(x map[string]any) bool {
					return x["path"] == path && x["ugid"] == id && x["roleid"] == role
				})
				if !del {
					s.acl = append(s.acl, map[string]any{"path": path, "type": kind, "ugid": id, "roleid": role, "propagate": prop})
				}
			}
		}
	}
	reply(w, nil)
}

func (s *Server) tfaList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for u, entries := range s.tfa {
		out = append(out, map[string]any{"userid": u, "entries": entries})
	}
	reply(w, out)
}

func (s *Server) tfaAdd(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tfa == nil {
		s.tfa = map[string][]map[string]any{}
	}
	id := token()[:8]
	u := r.PathValue("userid")
	typ := r.PostForm.Get("type")
	s.tfa[u] = append(s.tfa[u], map[string]any{"id": id, "type": typ, "description": r.PostForm.Get("description"), "created": time.Now().Unix(), "enable": 1})
	if typ == "recovery" {
		reply(w, map[string]any{"id": id, "recovery": []string{"a1b2-c3d4-e5f6-a7b8", "c9d0-e1f2-a3b4-c5d6", "e7f8-a9b0-c1d2-e3f4"}})
		return
	}
	reply(w, map[string]any{"id": id})
}

func (s *Server) tfaDelete(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := r.PathValue("userid")
	s.tfa[u] = slices.DeleteFunc(s.tfa[u], func(x map[string]any) bool { return x["id"] == r.PathValue("id") })
	reply(w, nil)
}

func (s *Server) poolsInit() {
	if s.pools == nil {
		s.pools = map[string]map[string]any{
			"casa":  {"poolid": "casa", "comment": "Automação da casa", "vms": []int{107, 103}, "storage": []string{}},
			"midia": {"poolid": "midia", "comment": "Mídia", "vms": []int{101, 112}, "storage": []string{"tank"}},
		}
	}
}

func (s *Server) poolList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.poolsInit()
	want := r.URL.Query().Get("poolid")
	out := []map[string]any{}
	for id, p := range s.pools {
		if want != "" && id != want {
			continue
		}
		members := []map[string]any{}
		for _, v := range p["vms"].([]int) {
			for _, g := range s.list {
				if g.vmid == v {
					members = append(members, map[string]any{"id": fmt.Sprintf("%s/%d", g.kind, v), "type": g.kind, "vmid": v, "name": g.name, "node": g.node, "status": s.status[v]})
				}
			}
		}
		for _, st := range p["storage"].([]string) {
			members = append(members, map[string]any{"id": "storage/" + st, "type": "storage", "storage": st})
		}
		out = append(out, map[string]any{"poolid": id, "comment": p["comment"], "members": members})
	}
	slices.SortFunc(out, func(x, y map[string]any) int { return strings.Compare(x["poolid"].(string), y["poolid"].(string)) })
	reply(w, out)
}

func (s *Server) poolCreate(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.poolsInit()
	id := r.PostForm.Get("poolid")
	if _, ok := s.pools[id]; ok || id == "" {
		fail(w, 500, "pool '"+id+"' already exists")
		return
	}
	s.pools[id] = map[string]any{"poolid": id, "comment": r.PostForm.Get("comment"), "vms": []int{}, "storage": []string{}}
	reply(w, nil)
}

func (s *Server) poolUpdate(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	f := r.PostForm
	s.mu.Lock()
	defer s.mu.Unlock()
	s.poolsInit()
	p := s.pools[f.Get("poolid")]
	if p == nil {
		fail(w, 404, "pool does not exist")
		return
	}
	if c := f.Get("comment"); c != "" {
		p["comment"] = c
	}
	del := f.Get("delete") == "1"
	for _, v := range strings.Split(f.Get("vms"), ",") {
		var id int
		if _, err := fmt.Sscan(v, &id); err != nil {
			continue
		}
		list := slices.DeleteFunc(p["vms"].([]int), func(x int) bool { return x == id })
		if !del {
			list = append(list, id)
		}
		p["vms"] = list
	}
	for _, st := range strings.Split(f.Get("storage"), ",") {
		if st == "" {
			continue
		}
		list := slices.DeleteFunc(p["storage"].([]string), func(x string) bool { return x == st })
		if !del {
			list = append(list, st)
		}
		p["storage"] = list
	}
	reply(w, nil)
}

func (s *Server) poolDelete(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.poolsInit()
	delete(s.pools, r.URL.Query().Get("poolid"))
	reply(w, nil)
}

// ---------- HA, replicação, opções, notificações, monitor ----------

func (s *Server) haStatus(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{
		{"id": "quorum", "type": "quorum", "status": "OK", "quorate": 1, "node": "pve-01"},
		{"id": "master", "type": "master", "status": "pve-02 (active, " + time.Now().Format("Mon Jan 2 15:04:05 2006") + ")", "node": "pve-02"},
	}
	for _, n := range nodes {
		out = append(out, map[string]any{"id": "lrm:" + n.name, "type": "lrm", "node": n.name, "status": n.name + " (active, " + time.Now().Format("15:04:05") + ")"})
	}
	s.rest.mu.Lock()
	for _, res := range s.rest.colls["/cluster/ha/resources"] {
		out = append(out, map[string]any{"id": "service:" + fmt.Sprint(res["sid"]), "type": "service", "sid": res["sid"], "node": "pve-02",
			"state": res["state"], "status": fmt.Sprintf("%v (pve-02, %v)", res["sid"], res["state"])})
	}
	s.rest.mu.Unlock()
	reply(w, out)
}

func (s *Server) replStatus(w http.ResponseWriter, r *http.Request) {
	s.rest.mu.Lock()
	defer s.rest.mu.Unlock()
	out := []map[string]any{}
	for _, j := range s.rest.colls["/cluster/replication"] {
		out = append(out, map[string]any{"id": j["id"], "guest": j["guest"], "target": j["target"], "schedule": j["schedule"],
			"last_sync": time.Now().Add(-9 * time.Minute).Unix(), "next_sync": time.Now().Add(6 * time.Minute).Unix(), "duration": 4.2, "fail_count": 0, "type": "local"})
	}
	reply(w, out)
}

func (s *Server) clusterOptions(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.copts == nil {
		s.copts = map[string]any{"keyboard": "pt-br", "console": "xtermjs", "email_from": "pve@homelab.lan", "mac_prefix": "BC:24:11",
			"next-id": "lower=100", "tag-style": "shape=circle", "migration": "type=secure", "description": "Homelab do Lucas.\n\nRack embaixo da escada."}
	}
	reply(w, s.copts)
}

func (s *Server) clusterOptionsPut(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, vs := range r.PostForm {
		if k == "delete" {
			for _, d := range strings.Split(vs[0], ",") {
				delete(s.copts, d)
			}
			continue
		}
		s.copts[k] = vs[0]
	}
	reply(w, nil)
}

func (s *Server) notifTargets(w http.ResponseWriter, r *http.Request) {
	s.rest.mu.Lock()
	defer s.rest.mu.Unlock()
	out := []map[string]any{}
	for _, t := range []string{"sendmail", "smtp", "gotify", "webhook"} {
		for _, e := range s.rest.colls["/cluster/notifications/endpoints/"+t] {
			out = append(out, map[string]any{"name": e["name"], "type": t, "comment": e["comment"], "disable": e["disable"], "origin": e["origin"]})
		}
	}
	reply(w, out)
}

func (s *Server) monitor(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	cmd := strings.TrimSpace(r.PostForm.Get("command"))
	out := map[string]string{
		"info status":  "VM status: running",
		"info cpus":    "* CPU #0: thread_id=4412\n  CPU #1: thread_id=4413",
		"info block":   "drive-scsi0 (#block183): /dev/zvol/tank/vm-" + r.PathValue("vmid") + "-disk-0 (raw)\n    Attached to:      scsi0\n    Cache mode:       writeback, direct",
		"info version": "9.2.0pve1",
		"help":         "info block\ninfo cpus\ninfo status\ninfo version\nsystem_reset\nsystem_powerdown",
	}[cmd]
	if out == "" {
		out = "unknown command: '" + cmd + "'"
	}
	reply(w, out)
}

// Um Ceph saudável de 3 nós, só leitura (criar e apagar viram tarefas que não mudam nada).
func (s *Server) cephRoutes(h func(string, http.HandlerFunc)) {
	nodes := []string{"pve-01", "pve-02", "pve-03"}
	h("GET /cluster/ceph/status", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"fsid": "5f0c1d2e-8a7b-4c3d-9e1f-0a2b3c4d5e6f", "health": map[string]any{"status": "HEALTH_OK"}})
	})
	h("GET /nodes/{node}/ceph/osd", func(w http.ResponseWriter, r *http.Request) {
		var hosts []map[string]any
		for i, n := range nodes {
			hosts = append(hosts, map[string]any{"type": "host", "name": n, "children": []map[string]any{
				{"type": "osd", "id": i, "name": fmt.Sprintf("osd.%d", i), "host": n, "status": "up", "in": 1, "device_class": "nvme", "percent_used": 21.4 + float64(i)},
			}})
		}
		reply(w, map[string]any{"root": map[string]any{"type": "root", "name": "default", "children": hosts}})
	})
	daemons := func(addr bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var out []map[string]any
			for i, n := range nodes {
				d := map[string]any{"name": n, "host": n, "state": "running"}
				if addr {
					d["addr"] = fmt.Sprintf("10.0.10.%d:6789", 11+i)
					d["quorum"] = 1
				}
				out = append(out, d)
			}
			reply(w, out)
		}
	}
	h("GET /nodes/{node}/ceph/mon", daemons(true))
	h("GET /nodes/{node}/ceph/mgr", daemons(false))
	h("GET /nodes/{node}/ceph/mds", daemons(false))
	h("GET /nodes/{node}/ceph/pool", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"pool_name": ".mgr", "size": 3, "min_size": 2, "pg_num": 1}, {"pool_name": "vms", "size": 3, "min_size": 2, "pg_num": 128}})
	})
	h("GET /nodes/{node}/ceph/fs", func(w http.ResponseWriter, r *http.Request) {
		reply(w, []map[string]any{{"name": "cephfs", "data_pool": "cephfs_data", "metadata_pool": "cephfs_metadata"}})
	})
	task := s.diskTask("cephcreate", "ceph: done")
	for _, p := range []string{"POST /nodes/{node}/ceph/osd", "POST /nodes/{node}/ceph/osd/{osdid}/out", "POST /nodes/{node}/ceph/osd/{osdid}/in",
		"POST /nodes/{node}/ceph/mon/{id}", "POST /nodes/{node}/ceph/mgr/{id}", "POST /nodes/{node}/ceph/mds/{id}"} {
		h(p, task)
	}
}

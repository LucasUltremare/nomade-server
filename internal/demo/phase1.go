package demo

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Endpoints do PVE falso pra Fase 1: IP dos guests (interfaces do LXC e
// agente da VM), hardware USB/PCI, ligar/desligar tudo, repositórios do apt.

func (s *Server) routesPhase1(mux *http.ServeMux) {
	mux.HandleFunc("GET /api2/json/nodes/{node}/lxc/{vmid}/interfaces", s.auth(s.lxcInterfaces))
	mux.HandleFunc("GET /api2/json/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces", s.auth(s.agentInterfaces))
	mux.HandleFunc("GET /api2/json/nodes/{node}/hardware/usb", s.auth(s.usbList))
	mux.HandleFunc("GET /api2/json/nodes/{node}/hardware/pci", s.auth(s.pciList))
	mux.HandleFunc("POST /api2/json/nodes/{node}/startall", s.auth(s.bulkPower))
	mux.HandleFunc("POST /api2/json/nodes/{node}/stopall", s.auth(s.bulkPower))
	mux.HandleFunc("GET /api2/json/nodes/{node}/apt/repositories", s.auth(s.repoList))
	mux.HandleFunc("POST /api2/json/nodes/{node}/apt/repositories", s.auth(s.repoToggle))
	mux.HandleFunc("PUT /api2/json/nodes/{node}/apt/repositories", s.auth(s.repoAdd))
}

func guestIP(vmid int) string { return fmt.Sprintf("10.0.10.%d", 20+vmid%200) }

func (s *Server) lxcInterfaces(w http.ResponseWriter, r *http.Request) {
	id := s.vmidOf(r)
	if s.statusOf(id) != "running" {
		fail(w, 500, "container not running")
		return
	}
	out := []map[string]string{
		{"name": "lo", "inet": "127.0.0.1/8", "hwaddr": "00:00:00:00:00:00"},
		{"name": "eth0", "inet": guestIP(id) + "/24", "hwaddr": fmt.Sprintf("BC:24:11:00:%02X:%02X", id/256, id%256)},
	}
	s.mu.Lock()
	for _, g := range s.list {
		if g.vmid == id && strings.Contains(g.tags, "tailscale") {
			out = append(out, map[string]string{"name": "tailscale0", "inet": fmt.Sprintf("100.101.%d.%d/32", id/256, id%256)})
		}
	}
	s.mu.Unlock()
	reply(w, out)
}

func (s *Server) agentInterfaces(w http.ResponseWriter, r *http.Request) {
	id := s.vmidOf(r)
	// Só a vlad e o homeassistant "têm" o agente instalado.
	if s.statusOf(id) != "running" || (id != 102 && id != 107) {
		fail(w, 500, "QEMU guest agent is not running")
		return
	}
	reply(w, map[string]any{"result": []map[string]any{
		{"name": "lo", "ip-addresses": []map[string]any{{"ip-address": "127.0.0.1", "ip-address-type": "ipv4", "prefix": 8}}},
		{"name": "ens18", "hardware-address": "bc:24:11:aa:bb:cc", "ip-addresses": []map[string]any{
			{"ip-address": guestIP(id), "ip-address-type": "ipv4", "prefix": 24},
			{"ip-address": "fe80::be24:11ff:feaa:bbcc", "ip-address-type": "ipv6", "prefix": 64},
		}},
	}})
}

func (s *Server) usbList(w http.ResponseWriter, r *http.Request) {
	reply(w, []map[string]any{
		{"busnum": 1, "devnum": 3, "port": 2, "usbpath": "1-2", "vendid": "1a86", "prodid": "55d4", "manufacturer": "ITead", "product": "Sonoff Zigbee 3.0 USB Dongle Plus V2", "speed": "12"},
		{"busnum": 1, "devnum": 4, "port": 3, "usbpath": "1-3", "vendid": "0bda", "prodid": "8153", "manufacturer": "Realtek", "product": "USB 10/100/1000 LAN", "speed": "5000"},
		{"busnum": 2, "devnum": 2, "port": 1, "usbpath": "2-1", "vendid": "0781", "prodid": "5583", "manufacturer": "SanDisk", "product": "Ultra Fit", "speed": "5000"},
	})
}

func (s *Server) pciList(w http.ResponseWriter, r *http.Request) {
	reply(w, []map[string]any{
		{"id": "0000:00:02.0", "class": "0x030000", "vendor_name": "Intel Corporation", "device_name": "Alder Lake-S GT1 [UHD Graphics 770]", "iommugroup": 0, "mdev": 1},
		{"id": "0000:01:00.0", "class": "0x030000", "vendor_name": "NVIDIA Corporation", "device_name": "GA106 [GeForce RTX 3060]", "iommugroup": 14},
		{"id": "0000:01:00.1", "class": "0x040300", "vendor_name": "NVIDIA Corporation", "device_name": "GA106 High Definition Audio Controller", "iommugroup": 14},
		{"id": "0000:03:00.0", "class": "0x010802", "vendor_name": "Samsung Electronics", "device_name": "NVMe SSD Controller PM9A1/980PRO", "iommugroup": 16},
		{"id": "0000:05:00.0", "class": "0x020000", "vendor_name": "Intel Corporation", "device_name": "I226-V 2.5GbE", "iommugroup": 18},
	})
}

func (s *Server) bulkPower(w http.ResponseWriter, r *http.Request) {
	node := r.PathValue("node")
	start := strings.HasSuffix(r.URL.Path, "/startall")
	var names []string
	s.mu.Lock()
	for _, g := range s.list {
		if g.node == node && !g.template {
			names = append(names, strconv.Itoa(g.vmid))
		}
	}
	s.mu.Unlock()
	verb := map[bool]string{true: "Starting", false: "Stopping"}[start]
	lines := []string{}
	for _, n := range names {
		lines = append(lines, fmt.Sprintf("%s VM/CT %s", verb, n))
	}
	typ := map[bool]string{true: "startall", false: "stopall"}[start]
	reply(w, s.newTask(node, typ, "", 3*time.Second, lines, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, g := range s.list {
			if g.node == node && !g.template {
				s.status[g.vmid] = map[bool]string{true: "running", false: "stopped"}[start]
			}
		}
	}))
}

// ---------- repositórios ----------

type repo struct {
	types, uri, suite, comps string
	enabled                  bool
}

func (s *Server) repos(node string) []repo {
	if s.aptRepos == nil {
		s.aptRepos = map[string][]repo{}
	}
	if s.aptRepos[node] == nil {
		s.aptRepos[node] = []repo{
			{"deb", "http://deb.debian.org/debian", "trixie", "main contrib", true},
			{"deb", "http://deb.debian.org/debian", "trixie-updates", "main contrib", true},
			{"deb", "http://security.debian.org/debian-security", "trixie-security", "main contrib", true},
			{"deb", "https://enterprise.proxmox.com/debian/pve", "trixie", "pve-enterprise", true},
			{"deb", "https://enterprise.proxmox.com/debian/ceph-squid", "trixie", "enterprise", true},
		}
	}
	return s.aptRepos[node]
}

func (s *Server) repoList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.repos(r.PathValue("node"))
	files := map[string][]map[string]any{}
	order := []string{}
	std := map[string]int{"enterprise": -1, "no-subscription": -1, "test": -1, "ceph-squid-enterprise": -1, "ceph-squid-no-subscription": -1}
	for _, rp := range list {
		path := "/etc/apt/sources.list.d/debian.sources"
		switch {
		case strings.Contains(rp.comps, "pve-enterprise"):
			path, std["enterprise"] = "/etc/apt/sources.list.d/pve-enterprise.sources", b2i(rp.enabled)
		case strings.Contains(rp.comps, "pve-no-subscription"):
			path, std["no-subscription"] = "/etc/apt/sources.list.d/proxmox.sources", b2i(rp.enabled)
		case strings.Contains(rp.comps, "pvetest"):
			path, std["test"] = "/etc/apt/sources.list.d/proxmox.sources", b2i(rp.enabled)
		case strings.Contains(rp.uri, "ceph"):
			path = "/etc/apt/sources.list.d/ceph.sources"
			if rp.comps == "enterprise" {
				std["ceph-squid-enterprise"] = b2i(rp.enabled)
			} else {
				std["ceph-squid-no-subscription"] = b2i(rp.enabled)
			}
		}
		if _, ok := files[path]; !ok {
			order = append(order, path)
		}
		files[path] = append(files[path], map[string]any{"Types": []string{rp.types}, "URIs": []string{rp.uri},
			"Suites": []string{rp.suite}, "Components": strings.Fields(rp.comps), "Enabled": b2i(rp.enabled), "FileType": "sources"})
	}
	out := []map[string]any{}
	for _, p := range order {
		out = append(out, map[string]any{"path": p, "file-type": "sources", "repositories": files[p]})
	}
	names := map[string]string{"enterprise": "Enterprise", "no-subscription": "No-Subscription", "test": "Test",
		"ceph-squid-enterprise": "Ceph Squid Enterprise", "ceph-squid-no-subscription": "Ceph Squid No-Subscription"}
	stdOut := []map[string]any{}
	for _, h := range []string{"enterprise", "no-subscription", "test", "ceph-squid-enterprise", "ceph-squid-no-subscription"} {
		row := map[string]any{"handle": h, "name": names[h]}
		if std[h] >= 0 {
			row["status"] = std[h]
		}
		stdOut = append(stdOut, row)
	}
	infos := []map[string]any{}
	if std["enterprise"] == 1 {
		infos = append(infos, map[string]any{"kind": "warning", "message": "no valid subscription - enterprise repository will fail with 401", "path": "/etc/apt/sources.list.d/pve-enterprise.sources", "index": "0"})
	}
	reply(w, map[string]any{"files": out, "standard-repos": stdOut, "digest": token(), "infos": infos, "errors": []any{}})
}

func (s *Server) repoToggle(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	path, idx, on := r.PostForm.Get("path"), r.PostForm.Get("index"), r.PostForm.Get("enabled") == "1"
	i, _ := strconv.Atoi(idx)
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.repos(r.PathValue("node"))
	// Acha a i-ésima linha daquele arquivo.
	n := 0
	for j, rp := range list {
		p := "/etc/apt/sources.list.d/debian.sources"
		switch {
		case strings.Contains(rp.comps, "pve-enterprise"):
			p = "/etc/apt/sources.list.d/pve-enterprise.sources"
		case strings.Contains(rp.comps, "pve-no-subscription") || strings.Contains(rp.comps, "pvetest"):
			p = "/etc/apt/sources.list.d/proxmox.sources"
		case strings.Contains(rp.uri, "ceph"):
			p = "/etc/apt/sources.list.d/ceph.sources"
		}
		if p != path {
			continue
		}
		if n == i {
			list[j].enabled = on
			reply(w, nil)
			return
		}
		n++
	}
	fail(w, 400, "invalid index")
}

func (s *Server) repoAdd(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	h := r.PostForm.Get("handle")
	comp := map[string]string{"no-subscription": "pve-no-subscription", "test": "pvetest", "ceph-squid-no-subscription": "no-subscription"}[h]
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.repos(r.PathValue("node"))
	if comp == "" {
		fail(w, 400, "unknown handle '"+h+"'")
		return
	}
	if slices.ContainsFunc(list, func(x repo) bool { return x.comps == comp }) {
		fail(w, 400, "repository already configured")
		return
	}
	uri := "http://download.proxmox.com/debian/pve"
	if strings.HasPrefix(h, "ceph") {
		uri = "http://download.proxmox.com/debian/ceph-squid"
	}
	s.aptRepos[r.PathValue("node")] = append(list, repo{"deb", uri, "trixie", comp, true})
	reply(w, nil)
}

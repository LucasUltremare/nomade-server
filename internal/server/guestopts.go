package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Opções, rede, dispositivos e opções de disco de um guest: o que o painel do
// PVE mostra em Options, Network, Hardware e Resources.

// kv é uma opção no formato do PVE: "primeiro,chave=valor,chave2=valor2".
type kv struct {
	first string
	keys  []string
	vals  map[string]string
}

func parseKV(s string) kv {
	out := kv{vals: map[string]string{}}
	for i, p := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(p, "=")
		if i == 0 && !ok {
			out.first = p
			continue
		}
		if !ok {
			k, v = p, ""
		}
		if _, seen := out.vals[k]; !seen {
			out.keys = append(out.keys, k)
		}
		out.vals[k] = v
	}
	return out
}

func (o *kv) set(k, v string) {
	if v == "" {
		if _, ok := o.vals[k]; ok {
			delete(o.vals, k)
			o.keys = slices.DeleteFunc(o.keys, func(x string) bool { return x == k })
		}
		return
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o kv) String() string {
	parts := []string{}
	if o.first != "" {
		parts = append(parts, o.first)
	}
	for _, k := range o.keys {
		parts = append(parts, k+"="+o.vals[k])
	}
	return strings.Join(parts, ",")
}

type netView struct {
	Key      string `json:"key"` // net0...
	Model    string `json:"model,omitempty"`
	Name     string `json:"name,omitempty"` // LXC: eth0
	MAC      string `json:"mac"`
	Bridge   string `json:"bridge"`
	IP       string `json:"ip,omitempty"` // LXC: dhcp | CIDR | ""
	GW       string `json:"gw,omitempty"`
	IP6      string `json:"ip6,omitempty"`
	GW6      string `json:"gw6,omitempty"`
	Tag      int    `json:"tag"`
	Firewall bool   `json:"firewall"`
	Rate     string `json:"rate,omitempty"`
	MTU      string `json:"mtu,omitempty"`
	LinkDown bool   `json:"linkDown"`
}

var qemuModels = []string{"virtio", "e1000", "e1000e", "vmxnet3", "rtl8139"}

func parseNet(key, raw, kind string) netView {
	o := parseKV(raw)
	n := netView{Key: key, Bridge: o.vals["bridge"], Firewall: o.vals["firewall"] == "1", Rate: o.vals["rate"], MTU: o.vals["mtu"], LinkDown: o.vals["link_down"] == "1"}
	n.Tag, _ = strconv.Atoi(o.vals["tag"])
	if kind == "lxc" {
		n.Name, n.MAC = o.vals["name"], o.vals["hwaddr"]
		n.IP, n.GW, n.IP6, n.GW6 = o.vals["ip"], o.vals["gw"], o.vals["ip6"], o.vals["gw6"]
		return n
	}
	// VM: "virtio=AA:BB:..." ou "model=virtio,macaddr=..."
	for _, m := range qemuModels {
		if mac, ok := o.vals[m]; ok {
			n.Model, n.MAC = m, mac
		}
	}
	if n.Model == "" {
		n.Model, n.MAC = o.vals["model"], o.vals["macaddr"]
	}
	return n
}

type deviceView struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"` // usb | pci | serial | dev
	Value string `json:"value"`
}

var (
	netKeyRe = regexp.MustCompile(`^net\d+$`)
	devKeyRe = regexp.MustCompile(`^(usb\d+|hostpci\d+|serial\d+|dev\d+)$`)
)

// Chaves que aparecem em Options/Hardware e podem ser editadas por aqui.
var optionKeys = map[string]*regexp.Regexp{
	"onboot":       regexp.MustCompile(`^[01]$`),
	"protection":   regexp.MustCompile(`^[01]$`),
	"startup":      regexp.MustCompile(`^(order=\d+)?(,?up=\d+)?(,?down=\d+)?$`),
	"description":  regexp.MustCompile(`(?s)^.*$`), // tamanho checado à parte
	"name":         hostnameRe,
	"hostname":     hostnameRe,
	"tags":         regexp.MustCompile(`^[a-z0-9_;+.-]{0,256}$`),
	"agent":        regexp.MustCompile(`^[01](,[a-z_]+=[a-z0-9]+)*$`),
	"ostype":       regexp.MustCompile(`^[a-z0-9]{2,16}$`),
	"boot":         regexp.MustCompile(`^order=[a-z0-9;]+$`),
	"features":     regexp.MustCompile(`^[a-z_]+=[a-z0-9;]+(,[a-z_]+=[a-z0-9;]+)*$`),
	"nameserver":   regexp.MustCompile(`^[0-9a-fA-F.: ]{0,200}$`),
	"searchdomain": regexp.MustCompile(`^[A-Za-z0-9. -]{0,200}$`),
	"cpu":          regexp.MustCompile(`^[A-Za-z0-9_.-]+(,[a-z-]+=[A-Za-z0-9;+_.-]+)*$`),
	"balloon":      regexp.MustCompile(`^\d{1,7}$`),
	"bios":         regexp.MustCompile(`^(seabios|ovmf)$`),
	"machine":      regexp.MustCompile(`^(pc|q35|pc-[a-z0-9.-]+)(,[a-z-]+=[a-z0-9.]+)*$`),
	"vga":          regexp.MustCompile(`^(std|virtio|qxl|vmware|serial0|none|virtio-gl|cirrus)(,memory=\d+)?$`),
	"cpulimit":     regexp.MustCompile(`^\d{1,3}(\.\d{1,2})?$`),
	"cpuunits":     regexp.MustCompile(`^\d{1,6}$`),
	"cmode":        regexp.MustCompile(`^(tty|console|shell)$`),
	"hotplug":      regexp.MustCompile(`^[a-z,]{0,64}$`),
	// Cloud-Init
	"ciuser":     regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`),
	"cipassword": regexp.MustCompile(`^[^\n]{1,128}$`),
	"sshkeys":    regexp.MustCompile(`^[A-Za-z0-9%._+=/@-]+$`),
	"ipconfig0":  regexp.MustCompile(`^(ip=(dhcp|[0-9./]+)(,gw=[0-9.]+)?)?(,?ip6=(dhcp|auto|[0-9a-fA-F:/]+)(,gw6=[0-9a-fA-F:]+)?)?$`),
	"citype":     regexp.MustCompile(`^(nocloud|configdrive2|opennebula)$`),
	"ciupgrade":  regexp.MustCompile(`^[01]$`),
}

// enrichConfig completa a resposta de /config com rede, dispositivos, opções
// e as opções de cada disco.
func enrichConfig(cfg *guestConfig, kind string, raw map[string]any) {
	str := func(k string) string {
		switch v := raw[k].(type) {
		case string:
			return v
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
		return ""
	}
	cfg.Nets, cfg.Devices, cfg.Options = []netView{}, []deviceView{}, map[string]string{}
	for k := range raw {
		switch {
		case netKeyRe.MatchString(k):
			cfg.Nets = append(cfg.Nets, parseNet(k, str(k), kind))
		case devKeyRe.MatchString(k):
			d := deviceView{Key: k, Value: str(k)}
			switch {
			case strings.HasPrefix(k, "usb"):
				d.Kind = "usb"
			case strings.HasPrefix(k, "hostpci"):
				d.Kind = "pci"
			case strings.HasPrefix(k, "serial"):
				d.Kind = "serial"
			default:
				d.Kind = "dev"
			}
			cfg.Devices = append(cfg.Devices, d)
		}
	}
	for k := range optionKeys {
		if v := str(k); v != "" {
			cfg.Options[k] = v
		}
	}
	for _, k := range []string{"unprivileged", "arch", "efidisk0", "tpmstate0", "sockets"} {
		if v := str(k); v != "" {
			cfg.Options[k] = v
		}
	}
	for i := range cfg.Disks {
		cfg.Disks[i].Opts = parseKV(str(cfg.Disks[i].Key)).vals
	}
	slices.SortFunc(cfg.Nets, func(x, y netView) int { return strings.Compare(x.Key, y.Key) })
	slices.SortFunc(cfg.Devices, func(x, y deviceView) int { return strings.Compare(x.Key, y.Key) })
}

func (s *Server) rawConfig(ctx context.Context, a pve.Auth, g pve.Resource) (map[string]string, error) {
	var raw map[string]any
	if err := s.pve.Get(ctx, &a, cfgPath(g), nil, &raw); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, v := range raw {
		switch x := v.(type) {
		case string:
			out[k] = x
		case float64:
			out[k] = strconv.FormatFloat(x, 'f', -1, 64)
		}
	}
	return out, nil
}

// handleGuestOptions grava opções da lista branca; "" apaga a opção.
func (s *Server) handleGuestOptions(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body map[string]string
	if err := readJSON(r, &body); err != nil || len(body) == 0 {
		writeErr(w, http.StatusBadRequest, "nada pra mudar")
		return
	}
	f := url.Values{}
	var del []string
	for k, v := range body {
		re, ok := optionKeys[k]
		if !ok || (k == "name" && g.Type != "qemu") || (k == "hostname" && g.Type != "lxc") {
			writeErr(w, http.StatusBadRequest, "opção não suportada: "+k)
			return
		}
		if v == "" {
			del = append(del, k)
			continue
		}
		if !re.MatchString(v) || len(v) > 8000 {
			writeErr(w, http.StatusBadRequest, "valor inválido pra "+k)
			return
		}
		f.Set(k, v)
	}
	if len(del) > 0 {
		f.Set("delete", strings.Join(del, ","))
	}
	upid, err := s.putConfig(r.Context(), a, g, f)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

var macRe = regexp.MustCompile(`^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)

// handleGuestNet cria ou edita uma placa de rede (preserva o MAC).
func (s *Server) handleGuestNet(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var n netView
	if err := readJSON(r, &n); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	if !ifaceRe.MatchString(n.Bridge) || (n.MAC != "" && !macRe.MatchString(n.MAC)) || n.Tag < 0 || n.Tag > 4094 {
		writeErr(w, http.StatusBadRequest, "bridge, MAC ou VLAN inválidos")
		return
	}
	raw, err := s.rawConfig(r.Context(), a, g)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	key := r.PathValue("net")
	if key == "new" {
		for i := 0; i < 32; i++ {
			if _, used := raw[fmt.Sprintf("net%d", i)]; !used {
				key = fmt.Sprintf("net%d", i)
				break
			}
		}
	}
	if !netKeyRe.MatchString(key) {
		writeErr(w, http.StatusBadRequest, "placa inválida")
		return
	}
	o := parseKV(raw[key])
	if g.Type == "lxc" {
		if !ifaceRe.MatchString(n.Name) {
			n.Name = "eth" + strings.TrimPrefix(key, "net")
		}
		o.first = ""
		o.set("name", n.Name)
		o.set("bridge", n.Bridge)
		o.set("hwaddr", cmpOr(n.MAC, o.vals["hwaddr"]))
		for k, v := range map[string]string{"ip": n.IP, "gw": n.GW, "ip6": n.IP6, "gw6": n.GW6} {
			if v != "" && v != "dhcp" && v != "auto" && v != "manual" {
				addr := v
				if strings.Contains(v, "/") {
					addr = v[:strings.Index(v, "/")]
				}
				if net.ParseIP(addr) == nil {
					writeErr(w, http.StatusBadRequest, "endereço inválido: "+v)
					return
				}
				if (k == "ip" || k == "ip6") && !strings.Contains(v, "/") {
					writeErr(w, http.StatusBadRequest, "IP fixo precisa do prefixo, ex.: 10.0.10.50/24")
					return
				}
			}
			o.set(k, v)
		}
		o.set("type", "veth")
	} else {
		model := n.Model
		if !slices.Contains(qemuModels, model) {
			model = "virtio"
		}
		mac := cmpOr(n.MAC, parseNet(key, raw[key], "qemu").MAC)
		// Troca o "modelo=MAC" mantendo o resto das opções.
		for _, m := range qemuModels {
			o.set(m, "")
		}
		o.set("model", "")
		o.set("macaddr", "")
		o.first = model
		if mac != "" {
			o.first = model + "=" + mac
		}
		o.set("bridge", n.Bridge)
	}
	tag := ""
	if n.Tag > 0 {
		tag = strconv.Itoa(n.Tag)
	}
	o.set("tag", tag)
	o.set("firewall", map[bool]string{true: "1", false: ""}[n.Firewall])
	o.set("link_down", map[bool]string{true: "1", false: ""}[n.LinkDown])
	if n.Rate != "" {
		if _, err := strconv.ParseFloat(n.Rate, 64); err != nil {
			writeErr(w, http.StatusBadRequest, "limite de banda inválido")
			return
		}
	}
	o.set("rate", n.Rate)
	if n.MTU != "" {
		if m, err := strconv.Atoi(n.MTU); err != nil || m < 576 || m > 65520 {
			writeErr(w, http.StatusBadRequest, "MTU inválido")
			return
		}
	}
	o.set("mtu", n.MTU)
	upid, err := s.putConfig(r.Context(), a, g, url.Values{key: {o.String()}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid, "key": key})
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// handleGuestDevice adiciona USB/PCI/serial (VM) ou dispositivo (LXC).
func (s *Server) handleGuestDevice(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Kind    string `json:"kind"` // usb | pci | serial | dev
		Host    string `json:"host"` // usb: vendor:product ou porta 1-2; pci: 0000:01:00
		PCIe    bool   `json:"pcie"`
		AllFunc bool   `json:"allFunctions"`
		Primary bool   `json:"primaryGpu"`
		Path    string `json:"path"` // dev: /dev/dri/renderD128
		GID     string `json:"gid"`
		UID     string `json:"uid"`
		Mode    string `json:"mode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	prefix, value := "", ""
	switch {
	case g.Type == "qemu" && body.Kind == "usb":
		if !regexp.MustCompile(`^([0-9a-fA-F]{4}:[0-9a-fA-F]{4}|\d+-[\d.]+|spice)$`).MatchString(body.Host) {
			writeErr(w, http.StatusBadRequest, "USB inválido (vendor:produto ou porta)")
			return
		}
		prefix, value = "usb", "host="+body.Host
		if body.Host == "spice" {
			value = "spice"
		}
	case g.Type == "qemu" && body.Kind == "pci":
		if !regexp.MustCompile(`^(0000:)?[0-9a-fA-F]{2}:[0-9a-fA-F]{2}(\.[0-7])?$`).MatchString(body.Host) {
			writeErr(w, http.StatusBadRequest, "endereço PCI inválido")
			return
		}
		id := body.Host
		if body.AllFunc {
			id = strings.SplitN(id, ".", 2)[0]
		}
		o := kv{first: id, vals: map[string]string{}}
		if body.PCIe {
			o.set("pcie", "1")
		}
		if body.Primary {
			o.set("x-vga", "1")
		}
		prefix, value = "hostpci", o.String()
	case g.Type == "qemu" && body.Kind == "serial":
		prefix, value = "serial", "socket"
	case g.Type == "lxc" && body.Kind == "dev":
		if !regexp.MustCompile(`^/dev/[A-Za-z0-9/_.:-]+$`).MatchString(body.Path) {
			writeErr(w, http.StatusBadRequest, "caminho de dispositivo inválido")
			return
		}
		o := kv{first: body.Path, vals: map[string]string{}}
		for k, v := range map[string]string{"gid": body.GID, "uid": body.UID, "mode": body.Mode} {
			if v != "" {
				if _, err := strconv.ParseUint(v, 8, 32); err != nil && k == "mode" {
					writeErr(w, http.StatusBadRequest, "modo inválido")
					return
				}
				if _, err := strconv.Atoi(v); err != nil && k != "mode" {
					writeErr(w, http.StatusBadRequest, k+" inválido")
					return
				}
				o.set(k, v)
			}
		}
		prefix, value = "dev", o.String()
	default:
		writeErr(w, http.StatusBadRequest, "dispositivo não suportado nesse tipo de guest")
		return
	}
	raw, err := s.rawConfig(r.Context(), a, g)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	key := ""
	for i := 0; i < 16; i++ {
		if _, used := raw[fmt.Sprintf("%s%d", prefix, i)]; !used {
			key = fmt.Sprintf("%s%d", prefix, i)
			break
		}
	}
	if key == "" {
		writeErr(w, http.StatusConflict, "sem slot livre")
		return
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{key: {value}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid, "key": key})
}

// handleConfigKeyDelete remove placa de rede ou dispositivo.
func (s *Server) handleConfigKeyDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	key := r.PathValue("key")
	if !netKeyRe.MatchString(key) && !devKeyRe.MatchString(key) {
		writeErr(w, http.StatusBadRequest, "item inválido")
		return
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{"delete": {key}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// Opções de disco que dá pra trocar sem recriar o disco.
var diskOptRe = map[string]*regexp.Regexp{
	"cache":        regexp.MustCompile(`^(none|writeback|writethrough|directsync|unsafe)?$`),
	"discard":      regexp.MustCompile(`^(on|ignore)?$`),
	"iothread":     regexp.MustCompile(`^[01]?$`),
	"ssd":          regexp.MustCompile(`^[01]?$`),
	"backup":       regexp.MustCompile(`^[01]?$`),
	"replicate":    regexp.MustCompile(`^[01]?$`),
	"ro":           regexp.MustCompile(`^[01]?$`),
	"mountoptions": regexp.MustCompile(`^[a-z;]{0,64}$`),
}

func (s *Server) handleDiskOptions(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	disk := r.PathValue("disk")
	if !diskKeyRe.MatchString(disk) || strings.HasPrefix(disk, "unused") {
		writeErr(w, http.StatusBadRequest, "disco inválido")
		return
	}
	var body map[string]string
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	raw, err := s.rawConfig(r.Context(), a, g)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	cur, ok := raw[disk]
	if !ok {
		writeErr(w, http.StatusNotFound, "disco não existe")
		return
	}
	o := parseKV(cur)
	for k, v := range body {
		re, ok := diskOptRe[k]
		if !ok || !re.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "opção de disco inválida: "+k)
			return
		}
		o.set(k, v)
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{disk: {o.String()}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// handleHardware lista USB e PCI do nó pra passthrough.
func (s *Server) handleHardware(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node := url.PathEscape(r.PathValue("node"))
	var usb []map[string]any
	var pci []map[string]any
	s.pve.Get(r.Context(), &a, "/nodes/"+node+"/hardware/usb", nil, &usb)
	s.pve.Get(r.Context(), &a, "/nodes/"+node+"/hardware/pci", url.Values{"pci-class-blacklist": {""}}, &pci)
	if usb == nil {
		usb = []map[string]any{}
	}
	if pci == nil {
		pci = []map[string]any{}
	}
	writeJSON(w, map[string]any{"usb": usb, "pci": pci})
}

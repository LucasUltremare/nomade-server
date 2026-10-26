package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Rede do nó. Mudanças ficam pendentes em /etc/network/interfaces.new até
// alguém aplicar (PUT) ou reverter (DELETE), igual no painel do Proxmox.

type ifaceView struct {
	Iface       string    `json:"iface"`
	Type        string    `json:"type"`
	Active      bool      `json:"active"`
	Autostart   bool      `json:"autostart"`
	Method      string    `json:"method"`
	CIDR        string    `json:"cidr"`
	Gateway     string    `json:"gateway"`
	CIDR6       string    `json:"cidr6"`
	Ports       string    `json:"ports"`
	VLANAware   bool      `json:"vlanAware"`
	VLANID      string    `json:"vlanId"`
	VLANRaw     string    `json:"vlanRaw"`
	BondMode    string    `json:"bondMode"`
	Comments    string    `json:"comments"`
	Pending     bool      `json:"pending"`
	PendingKeys []string  `json:"pendingKeys"`
	Link        *linkInfo `json:"link,omitempty"`
}

type rawIface struct {
	Iface     string          `json:"iface"`
	Type      string          `json:"type"`
	Active    pve.Bool        `json:"active"`
	Autostart pve.Bool        `json:"autostart"`
	Method    string          `json:"method"`
	CIDR      string          `json:"cidr"`
	Gateway   string          `json:"gateway"`
	CIDR6     string          `json:"cidr6"`
	Ports     string          `json:"bridge_ports"`
	Slaves    string          `json:"slaves"`
	VLANAware pve.Bool        `json:"bridge_vlan_aware"`
	VLANID    pve.Num         `json:"vlan-id"`
	VLANRaw   string          `json:"vlan-raw-device"`
	BondMode  string          `json:"bond_mode"`
	Comments  string          `json:"comments"`
	Pending   json.RawMessage `json:"pending"`
}

func (s *Server) handleNetwork(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node := r.PathValue("node")
	var raw []rawIface
	env, err := s.pve.GetEnvelope(r.Context(), &a, "/nodes/"+url.PathEscape(node)+"/network", nil, &raw)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var changes string
	if c, ok := env["changes"]; ok {
		json.Unmarshal(c, &changes)
	}
	out := []ifaceView{}
	for _, x := range raw {
		v := ifaceView{
			Iface: x.Iface, Type: x.Type, Active: bool(x.Active), Autostart: bool(x.Autostart), Method: x.Method,
			CIDR: x.CIDR, Gateway: x.Gateway, CIDR6: x.CIDR6, Ports: x.Ports, VLANAware: bool(x.VLANAware),
			VLANRaw: x.VLANRaw, BondMode: x.BondMode, Comments: strings.TrimSpace(x.Comments), PendingKeys: []string{},
		}
		if v.Ports == "" {
			v.Ports = x.Slaves
		}
		if x.VLANID > 0 {
			v.VLANID = strconv.Itoa(int(x.VLANID))
		}
		var pend map[string]any
		if len(x.Pending) > 0 && json.Unmarshal(x.Pending, &pend) == nil && len(pend) > 0 {
			v.Pending = true
			for k := range pend {
				v.PendingKeys = append(v.PendingKeys, k)
			}
			slices.Sort(v.PendingKeys)
		}
		out = append(out, v)
	}
	order := map[string]int{"bridge": 0, "OVSBridge": 0, "vlan": 1, "bond": 2, "eth": 3}
	slices.SortFunc(out, func(x, y ifaceView) int {
		ox, oy := order[x.Type], order[y.Type]
		if _, ok := order[x.Type]; !ok {
			ox = 9
		}
		if _, ok := order[y.Type]; !ok {
			oy = 9
		}
		if ox != oy {
			return ox - oy
		}
		return strings.Compare(x.Iface, y.Iface)
	})

	// Tráfego: última amostra do rrd da última hora.
	traffic := map[string]float64{}
	if pts, err := s.pve.NodeRRD(r.Context(), &a, node, "hour"); err == nil {
		for i := len(pts) - 1; i >= 0; i-- {
			in, ok1 := pts[i].F("netin")
			outB, ok2 := pts[i].F("netout")
			if ok1 && ok2 {
				traffic["in"], traffic["out"] = in, outB
				break
			}
		}
	}
	// Link e tráfego por porta: só no nó onde o Mia roda (lê o /sys).
	names := make([]string, len(out))
	for i, v := range out {
		names[i] = v.Iface
	}
	links := s.links(node, names)
	for i := range out {
		if li, ok := links[out[i].Iface]; ok {
			out[i].Link = &li
		}
	}
	writeJSON(w, map[string]any{"ifaces": out, "changes": changes, "traffic": traffic, "live": links != nil})
}

var (
	ifaceRe   = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$`)
	bondRe    = regexp.MustCompile(`^bond\d{1,3}$`)
	bondModes = []string{"balance-rr", "active-backup", "balance-xor", "broadcast", "802.3ad", "balance-tlb", "balance-alb"}
)

type ifaceBody struct {
	Type      string `json:"type"` // bridge | vlan | bond
	Iface     string `json:"iface"`
	CIDR      string `json:"cidr"`
	Gateway   string `json:"gateway"`
	Ports     string `json:"ports"` // bridge: portas; bond: placas
	VLANAware bool   `json:"vlanAware"`
	VLANRaw   string `json:"vlanRaw"`
	VLANID    int    `json:"vlanId"`
	BondMode  string `json:"bondMode"`
	Comments  string `json:"comments"`
}

// validPorts aceita "enp5s0 enp6s0" (nomes de interface separados por espaço).
func validPorts(p string) bool {
	for _, x := range strings.Fields(p) {
		if !ifaceRe.MatchString(x) {
			return false
		}
	}
	return true
}

// form monta os campos comuns de criar e editar. del lista o que ficou vazio
// (pra apagar na edição).
func (b ifaceBody) form() (f url.Values, del []string, err string) {
	f = url.Values{"type": {b.Type}}
	if !validPorts(b.Ports) {
		return nil, nil, "portas inválidas"
	}
	opt := map[string]string{"cidr": b.CIDR, "gateway": b.Gateway, "comments": b.Comments}
	switch b.Type {
	case "bridge":
		opt["bridge_ports"] = b.Ports
		if b.VLANAware {
			f.Set("bridge_vlan_aware", "1")
		} else {
			del = append(del, "bridge_vlan_aware")
		}
	case "bond":
		if strings.TrimSpace(b.Ports) == "" {
			return nil, nil, "bond precisa de pelo menos uma placa"
		}
		if !slices.Contains(bondModes, b.BondMode) {
			return nil, nil, "modo de bond inválido"
		}
		f.Set("slaves", strings.Join(strings.Fields(b.Ports), " "))
		f.Set("bond_mode", b.BondMode)
		if b.BondMode == "802.3ad" || b.BondMode == "balance-xor" {
			f.Set("bond_xmit_hash_policy", "layer2+3")
		}
	case "vlan", "eth":
	default:
		return nil, nil, "tipo inválido"
	}
	for k, v := range opt {
		if v = strings.TrimSpace(v); v != "" {
			f.Set(k, v)
		} else {
			del = append(del, k)
		}
	}
	slices.Sort(del)
	return f, del, ""
}

func (s *Server) handleNetworkCreate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body ifaceBody
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	switch body.Type {
	case "bridge":
		if !strings.HasPrefix(body.Iface, "vmbr") || !ifaceRe.MatchString(body.Iface) {
			writeErr(w, http.StatusBadRequest, "nome de bridge precisa ser vmbrN")
			return
		}
	case "bond":
		if !bondRe.MatchString(body.Iface) {
			writeErr(w, http.StatusBadRequest, "nome de bond precisa ser bondN")
			return
		}
	case "vlan":
		if !ifaceRe.MatchString(body.VLANRaw) || body.VLANID < 1 || body.VLANID > 4094 {
			writeErr(w, http.StatusBadRequest, "VLAN precisa de interface base e ID entre 1 e 4094")
			return
		}
		body.Iface = body.VLANRaw + "." + strconv.Itoa(body.VLANID)
	default:
		writeErr(w, http.StatusBadRequest, "tipo inválido")
		return
	}
	f, _, msg := body.form()
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	f.Set("iface", body.Iface)
	f.Set("autostart", "1")
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/network", f, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleNetworkUpdate edita uma interface (fica pendente até aplicar, como criar).
func (s *Server) handleNetworkUpdate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	iface := r.PathValue("iface")
	var body ifaceBody
	if err := readJSON(r, &body); err != nil || !ifaceRe.MatchString(iface) {
		writeErr(w, http.StatusBadRequest, "pedido inválido")
		return
	}
	f, del, msg := body.form()
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if len(del) > 0 {
		f.Set("delete", strings.Join(del, ","))
	}
	path := "/nodes/" + url.PathEscape(r.PathValue("node")) + "/network/" + url.PathEscape(iface)
	if err := s.pve.Put(r.Context(), &a, path, f, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleNetworkDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	iface := r.PathValue("iface")
	if !ifaceRe.MatchString(iface) {
		writeErr(w, http.StatusBadRequest, "interface inválida")
		return
	}
	path := "/nodes/" + url.PathEscape(r.PathValue("node")) + "/network/" + url.PathEscape(iface)
	if err := s.pve.Delete(r.Context(), &a, path, nil, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleNetworkApply aplica (POST .../apply) ou descarta (POST .../revert) as pendências.
func (s *Server) handleNetworkApply(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	path := "/nodes/" + url.PathEscape(r.PathValue("node")) + "/network"
	var upid string
	var err error
	if r.PathValue("op") == "apply" {
		err = s.pve.Put(r.Context(), &a, path, nil, &upid)
	} else {
		err = s.pve.Delete(r.Context(), &a, path, nil, nil)
	}
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

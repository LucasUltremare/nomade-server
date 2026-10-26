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
	Iface       string   `json:"iface"`
	Type        string   `json:"type"`
	Active      bool     `json:"active"`
	Autostart   bool     `json:"autostart"`
	Method      string   `json:"method"`
	CIDR        string   `json:"cidr"`
	Gateway     string   `json:"gateway"`
	CIDR6       string   `json:"cidr6"`
	Ports       string   `json:"ports"`
	VLANAware   bool     `json:"vlanAware"`
	VLANID      string   `json:"vlanId"`
	VLANRaw     string   `json:"vlanRaw"`
	Comments    string   `json:"comments"`
	Pending     bool     `json:"pending"`
	PendingKeys []string `json:"pendingKeys"`
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
			VLANRaw: x.VLANRaw, Comments: strings.TrimSpace(x.Comments), PendingKeys: []string{},
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
	writeJSON(w, map[string]any{"ifaces": out, "changes": changes, "traffic": traffic})
}

var ifaceRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$`)

func (s *Server) handleNetworkCreate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		Type      string `json:"type"` // bridge | vlan
		Iface     string `json:"iface"`
		CIDR      string `json:"cidr"`
		Gateway   string `json:"gateway"`
		Ports     string `json:"ports"`
		VLANAware bool   `json:"vlanAware"`
		VLANRaw   string `json:"vlanRaw"`
		VLANID    int    `json:"vlanId"`
		Comments  string `json:"comments"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	f := url.Values{"autostart": {"1"}}
	switch body.Type {
	case "bridge":
		if !strings.HasPrefix(body.Iface, "vmbr") || !ifaceRe.MatchString(body.Iface) {
			writeErr(w, http.StatusBadRequest, "nome de bridge precisa ser vmbrN")
			return
		}
		f.Set("type", "bridge")
		f.Set("iface", body.Iface)
		if body.Ports != "" {
			f.Set("bridge_ports", body.Ports)
		}
		if body.VLANAware {
			f.Set("bridge_vlan_aware", "1")
		}
	case "vlan":
		if body.VLANRaw == "" || body.VLANID < 1 || body.VLANID > 4094 {
			writeErr(w, http.StatusBadRequest, "VLAN precisa de interface base e ID entre 1 e 4094")
			return
		}
		f.Set("type", "vlan")
		f.Set("iface", body.VLANRaw+"."+strconv.Itoa(body.VLANID))
	default:
		writeErr(w, http.StatusBadRequest, "tipo inválido")
		return
	}
	if body.CIDR != "" {
		f.Set("cidr", body.CIDR)
	}
	if body.Gateway != "" {
		f.Set("gateway", body.Gateway)
	}
	if body.Comments != "" {
		f.Set("comments", body.Comments)
	}
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/network", f, nil); err != nil {
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

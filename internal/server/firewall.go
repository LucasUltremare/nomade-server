package server

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Firewall do Proxmox em três níveis: datacenter (cluster), nó e guest.
// Cada nível tem opções (ligado, política padrão) e uma lista de regras
// ordenada por posição.

// fwBase devolve o prefixo da API pro escopo pedido.
func (s *Server) fwBase(r *http.Request, a pve.Auth) (string, error) {
	q := r.URL.Query()
	switch q.Get("scope") {
	case "cluster", "":
		return "/cluster/firewall", nil
	case "node":
		if q.Get("node") == "" {
			return "", fmt.Errorf("nó obrigatório")
		}
		return "/nodes/" + url.PathEscape(q.Get("node")) + "/firewall", nil
	case "guest":
		vmid, _ := strconv.Atoi(q.Get("vmid"))
		kind := q.Get("kind")
		if vmid < 1 || (kind != "qemu" && kind != "lxc") {
			return "", fmt.Errorf("guest inválido")
		}
		g, err := s.findGuest(r.Context(), a, kind, vmid)
		if err != nil {
			return "", err
		}
		return pve.GuestPath(g.Node, g.Type, g.VMID) + "/firewall", nil
	}
	return "", fmt.Errorf("escopo inválido")
}

type fwRule struct {
	Pos     int    `json:"pos"`
	Type    string `json:"type"`   // in | out | group
	Action  string `json:"action"` // ACCEPT | DROP | REJECT | nome do grupo
	Macro   string `json:"macro"`
	Proto   string `json:"proto"`
	Dport   string `json:"dport"`
	Sport   string `json:"sport"`
	Source  string `json:"source"`
	Dest    string `json:"dest"`
	Iface   string `json:"iface"`
	Log     string `json:"log"`
	Comment string `json:"comment"`
	Enable  bool   `json:"enable"`
}

func (s *Server) handleFirewall(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	base, err := s.fwBase(r, a)
	if err != nil {
		writeErrOrPVE(w, err)
		return
	}
	var opts map[string]any
	if err := s.pve.Get(r.Context(), &a, base+"/options", nil, &opts); err != nil {
		writePVEErr(w, err)
		return
	}
	var raw []struct {
		Pos     int      `json:"pos"`
		Type    string   `json:"type"`
		Action  string   `json:"action"`
		Macro   string   `json:"macro"`
		Proto   string   `json:"proto"`
		Dport   string   `json:"dport"`
		Sport   string   `json:"sport"`
		Source  string   `json:"source"`
		Dest    string   `json:"dest"`
		Iface   string   `json:"iface"`
		Log     string   `json:"log"`
		Comment string   `json:"comment"`
		Enable  pve.Bool `json:"enable"`
	}
	if err := s.pve.Get(r.Context(), &a, base+"/rules", nil, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	rules := []fwRule{}
	for _, x := range raw {
		rules = append(rules, fwRule{Pos: x.Pos, Type: x.Type, Action: x.Action, Macro: x.Macro, Proto: x.Proto,
			Dport: x.Dport, Sport: x.Sport, Source: x.Source, Dest: x.Dest, Iface: x.Iface, Log: x.Log, Comment: x.Comment, Enable: bool(x.Enable)})
	}
	slices.SortFunc(rules, func(x, y fwRule) int { return x.Pos - y.Pos })

	str := func(k, def string) string {
		if v, ok := opts[k]; ok {
			return fmt.Sprint(v)
		}
		return def
	}
	scope := r.URL.Query().Get("scope")
	// Padrões do PVE: datacenter desligado, nó ligado, guest desligado.
	enableDef := map[string]string{"cluster": "0", "": "0", "node": "1", "guest": "0"}[scope]
	out := map[string]any{
		"enable":    str("enable", enableDef) == "1",
		"policyIn":  str("policy_in", "DROP"),
		"policyOut": str("policy_out", "ACCEPT"),
		"rules":     rules,
	}
	if scope == "cluster" || scope == "" {
		port := s.listenPort()
		out["miaPort"] = port
		out["miaPortOpen"] = slices.ContainsFunc(rules, func(x fwRule) bool {
			return x.Enable && x.Type == "in" && x.Action == "ACCEPT" && portMatches(x.Dport, port)
		})
	}
	writeJSON(w, out)
}

func writeErrOrPVE(w http.ResponseWriter, err error) {
	if _, ok := err.(*pve.Error); ok {
		writePVEErr(w, err)
		return
	}
	writeErr(w, http.StatusBadRequest, err.Error())
}

func (s *Server) listenPort() int {
	_, p, err := net.SplitHostPort(s.cfg.Listen)
	if err != nil {
		return 8443
	}
	n, _ := strconv.Atoi(p)
	return n
}

// portMatches entende "8443", "80,443", "8000:9000".
func portMatches(spec string, port int) bool {
	for _, part := range strings.Split(spec, ",") {
		if lo, hi, ok := strings.Cut(part, ":"); ok {
			l, _ := strconv.Atoi(lo)
			h, _ := strconv.Atoi(hi)
			if port >= l && port <= h {
				return true
			}
		} else if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n == port {
			return true
		}
	}
	return false
}

func (s *Server) handleFirewallOptions(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	base, err := s.fwBase(r, a)
	if err != nil {
		writeErrOrPVE(w, err)
		return
	}
	var body struct {
		Enable    *bool  `json:"enable"`
		PolicyIn  string `json:"policyIn"`
		PolicyOut string `json:"policyOut"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	f := url.Values{}
	if body.Enable != nil {
		f.Set("enable", b01(*body.Enable))
	}
	for k, v := range map[string]string{"policy_in": body.PolicyIn, "policy_out": body.PolicyOut} {
		if v != "" {
			if !slices.Contains([]string{"ACCEPT", "DROP", "REJECT"}, v) {
				writeErr(w, http.StatusBadRequest, "política inválida")
				return
			}
			f.Set(k, v)
		}
	}
	if err := s.pve.Put(r.Context(), &a, base+"/options", f, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

var (
	fwFieldRe = regexp.MustCompile(`^[A-Za-z0-9.:/,+_\-!]{0,256}$`)
	fwWordRe  = regexp.MustCompile(`^[A-Za-z0-9_\-]{0,64}$`)
)

var fwLogLevels = []string{"", "nolog", "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"}

// form valida a regra e monta os campos pro PVE; del lista os vazios (pra
// apagar na edição).
func (x fwRule) form() (url.Values, []string, error) {
	if x.Type != "in" && x.Type != "out" {
		return nil, nil, fmt.Errorf("direção inválida")
	}
	if !slices.Contains([]string{"ACCEPT", "DROP", "REJECT"}, x.Action) {
		return nil, nil, fmt.Errorf("ação inválida")
	}
	if !slices.Contains(fwLogLevels, x.Log) {
		return nil, nil, fmt.Errorf("nível de log inválido")
	}
	for _, v := range []string{x.Dport, x.Sport, x.Source, x.Dest} {
		if !fwFieldRe.MatchString(v) {
			return nil, nil, fmt.Errorf("valor inválido: %s", v)
		}
	}
	for _, v := range []string{x.Macro, x.Proto, x.Iface} {
		if !fwWordRe.MatchString(v) {
			return nil, nil, fmt.Errorf("valor inválido: %s", v)
		}
	}
	f := url.Values{"type": {x.Type}, "action": {x.Action}, "enable": {b01(x.Enable)}}
	var del []string
	for k, v := range map[string]string{"macro": x.Macro, "proto": x.Proto, "dport": x.Dport, "sport": x.Sport,
		"source": x.Source, "dest": x.Dest, "iface": x.Iface, "log": x.Log, "comment": x.Comment} {
		if v != "" {
			f.Set(k, v)
		} else {
			del = append(del, k)
		}
	}
	slices.Sort(del)
	return f, del, nil
}

func (s *Server) handleFirewallRuleAdd(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	base, err := s.fwBase(r, a)
	if err != nil {
		writeErrOrPVE(w, err)
		return
	}
	var x fwRule
	if err := readJSON(r, &x); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	f, _, err := x.form()
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.pve.Post(r.Context(), &a, base+"/rules", f, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleFirewallRuleUpdate liga/desliga ({enable}), move ({moveto}) ou
// troca a regra inteira ({rule}).
func (s *Server) handleFirewallRuleUpdate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	base, err := s.fwBase(r, a)
	if err != nil {
		writeErrOrPVE(w, err)
		return
	}
	var body struct {
		Enable *bool   `json:"enable"`
		MoveTo *int    `json:"moveto"`
		Rule   *fwRule `json:"rule"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	pos := r.PathValue("pos")
	if _, err := strconv.Atoi(pos); err != nil {
		writeErr(w, http.StatusBadRequest, "posição inválida")
		return
	}
	f := url.Values{}
	switch {
	case body.Rule != nil:
		var del []string
		if f, del, err = body.Rule.form(); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if len(del) > 0 {
			f.Set("delete", strings.Join(del, ","))
		}
	case body.MoveTo != nil:
		if *body.MoveTo < 0 {
			writeErr(w, http.StatusBadRequest, "posição inválida")
			return
		}
		f.Set("moveto", strconv.Itoa(*body.MoveTo))
	case body.Enable != nil:
		f.Set("enable", b01(*body.Enable))
	default:
		writeErr(w, http.StatusBadRequest, "nada pra mudar")
		return
	}
	if err := s.pve.Put(r.Context(), &a, base+"/rules/"+pos, f, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleFirewallRuleDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	base, err := s.fwBase(r, a)
	if err != nil {
		writeErrOrPVE(w, err)
		return
	}
	pos := r.PathValue("pos")
	if _, err := strconv.Atoi(pos); err != nil {
		writeErr(w, http.StatusBadRequest, "posição inválida")
		return
	}
	if err := s.pve.Delete(r.Context(), &a, base+"/rules/"+pos, nil, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleFirewallMacros(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	macros, err := cached(s.cache, a.User, "fw-macros", time.Hour, func() ([]map[string]string, error) {
		var out []map[string]string
		return out, s.pve.Get(r.Context(), &a, "/cluster/firewall/macros", nil, &out)
	})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, macros)
}

package server

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// O console usa o próprio terminal do Proxmox: o Mia pede um termproxy pela
// API e o navegador conversa com ele por um websocket que o Mia repassa pro
// pveproxy com o ticket do usuário. O protocolo é o do xterm.js do PVE
// (pve-xtermjs): "user:ticket\n" pra autenticar, "0:len:dados" pra teclas,
// "1:cols:rows:" pra redimensionar e "2" de ping.

func consoleTarget(r *http.Request) (node, kind string, vmid int, ok bool) {
	node, kind = r.FormValue("node"), r.FormValue("kind")
	vmid, _ = strconv.Atoi(r.FormValue("vmid"))
	switch kind {
	case "node":
		return node, kind, 0, node != ""
	case "lxc", "qemu":
		return node, kind, vmid, node != "" && vmid > 0
	}
	return "", "", 0, false
}

func (s *Server) handleConsoleOpen(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		Node string `json:"node"`
		Kind string `json:"kind"`
		VMID int    `json:"vmid"`
		Cmd  string `json:"cmd"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	if body.Node == "" || (body.Kind != "node" && body.Kind != "lxc" && body.Kind != "qemu") || (body.Kind != "node" && body.VMID <= 0) {
		writeErr(w, http.StatusBadRequest, "console inválido")
		return
	}
	if body.Kind == "qemu" {
		// VM: console gráfico (VNC) via noVNC no navegador.
		var t pve.Term
		path := pve.GuestPath(body.Node, "qemu", body.VMID) + "/vncproxy"
		if err := s.pve.Post(r.Context(), &a, path, url.Values{"websocket": {"1"}}, &t); err != nil {
			writePVEErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"node": body.Node, "kind": "qemu", "vmid": body.VMID, "port": int(t.Port), "ticket": t.Ticket, "user": a.User})
		return
	}
	if body.Cmd != "" && body.Cmd != "upgrade" {
		writeErr(w, http.StatusBadRequest, "comando inválido")
		return
	}
	t, err := s.pve.Termproxy(r.Context(), &a, body.Node, body.Kind, body.VMID, body.Cmd)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"node": body.Node, "kind": body.Kind, "vmid": body.VMID,
		"port": int(t.Port), "ticket": t.Ticket, "user": a.User,
	})
}

// handleConsoleWS repassa o websocket do navegador pro vncwebsocket do pveproxy.
func (s *Server) handleConsoleWS(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node, kind, vmid, ok := consoleTarget(r)
	port := r.FormValue("port")
	ticket := r.FormValue("vncticket")
	if !ok || port == "" || ticket == "" {
		writeErr(w, http.StatusBadRequest, "console inválido")
		return
	}
	target, err := url.Parse(s.pve.Endpoint(pve.GuestPath(node, kind, vmid) + "/vncwebsocket"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	target.RawQuery = url.Values{"port": {port}, "vncticket": {ticket}}.Encode()

	proxy := &httputil.ReverseProxy{
		Transport: s.pve.Transport(),
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = target
			pr.Out.Host = target.Host
			// Cookie do Mia não vai pro PVE; o do PVE vai no lugar.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Origin")
			pr.Out.AddCookie(&http.Cookie{Name: "PVEAuthCookie", Value: a.Ticket})
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeErr(w, http.StatusBadGateway, "console: "+err.Error())
		},
	}
	proxy.ServeHTTP(w, r)
}

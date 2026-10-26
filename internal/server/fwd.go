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

// fwd monta um handler que repassa uma chamada pra API do PVE: o caminho vem
// do modelo (com {node}, {id}... trocados pelos valores da URL do Mia, já
// escapados) e só os parâmetros listados passam. As permissões são as do
// próprio usuário no PVE, então isso não dá a ninguém mais poder do que o
// painel do Proxmox daria. Serve pras telas que são "o formulário do PVE".
//
// A resposta é o "data" do PVE, cru.
func (s *Server) fwd(method, tpl string, params ...string) http.HandlerFunc {
	allowed := map[string]bool{}
	for _, p := range params {
		allowed[p] = true
	}
	return s.authed(func(w http.ResponseWriter, r *http.Request, a pve.Auth) {
		path, ok := fillPath(tpl, r)
		if !ok {
			writeErr(w, http.StatusBadRequest, "caminho inválido")
			return
		}
		f := url.Values{}
		if method == http.MethodGet || method == http.MethodDelete {
			for k, vs := range r.URL.Query() {
				if allowed[k] {
					f[k] = vs
				}
			}
		}
		if method == http.MethodPost || method == http.MethodPut || (method == http.MethodDelete && r.ContentLength > 0) {
			var body map[string]any
			if r.ContentLength != 0 {
				if err := readJSON(r, &body); err != nil {
					writeErr(w, http.StatusBadRequest, "json inválido")
					return
				}
			}
			for k, v := range body {
				if !allowed[k] {
					writeErr(w, http.StatusBadRequest, "parâmetro não aceito: "+k)
					return
				}
				addForm(f, k, v)
			}
		}
		var out json.RawMessage
		var err error
		switch method {
		case http.MethodGet:
			err = s.pve.Get(r.Context(), &a, path, f, &out)
		case http.MethodPost:
			err = s.pve.Post(r.Context(), &a, path, f, &out)
		case http.MethodPut:
			err = s.pve.Put(r.Context(), &a, path, f, &out)
		case http.MethodDelete:
			err = s.pve.Delete(r.Context(), &a, path, f, &out)
		}
		if err != nil {
			writePVEErr(w, err)
			return
		}
		if method != http.MethodGet {
			s.cache.invalidate(a.User)
		}
		if len(out) == 0 {
			out = json.RawMessage("null")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(out)
	})
}

var pathVarRe = regexp.MustCompile(`\{([a-z]+)\}`)

// fillPath troca {x} pelo PathValue("x") escapado; recusa valor vazio ou com "..".
func fillPath(tpl string, r *http.Request) (string, bool) {
	ok := true
	out := pathVarRe.ReplaceAllStringFunc(tpl, func(m string) string {
		v := r.PathValue(m[1 : len(m)-1])
		if v == "" || v == "." || v == ".." || strings.ContainsAny(v, "\x00") {
			ok = false
		}
		return url.PathEscape(v)
	})
	return out, ok
}

func addForm(f url.Values, k string, v any) {
	switch x := v.(type) {
	case nil:
	case string:
		f.Add(k, x)
	case bool:
		f.Add(k, b01(x))
	case float64:
		f.Add(k, strconv.FormatFloat(x, 'f', -1, 64))
	case []any:
		for _, e := range x {
			addForm(f, k, e)
		}
	}
}

// route registra várias rotas fwd de uma vez: "MÉTODO /api/caminho" -> PVE.
type fwdRoute struct {
	pattern string // ex.: "GET /api/nodes/{node}/dns"
	pve     string // ex.: "/nodes/{node}/dns"
	params  []string
}

func (s *Server) fwdRoutes(mux *http.ServeMux, routes []fwdRoute) {
	for _, rt := range routes {
		method, _, _ := strings.Cut(rt.pattern, " ")
		mux.HandleFunc(rt.pattern, s.fwd(method, rt.pve, rt.params...))
	}
}

// p junta listas de parâmetros (pra reaproveitar entre criar e editar).
func p(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

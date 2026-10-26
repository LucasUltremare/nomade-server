package server

import (
	"cmp"
	"net/http"
	"slices"
	"strings"
	"sync"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Pastas compartilhadas: pastas do host montadas (bind mount) em LXCs.
// Criar e montar roda no console do nó (precisa de root); aqui só lista.

type sharedMount struct {
	VMID int    `json:"vmid"`
	Name string `json:"name"`
	Key  string `json:"key"`
	MP   string `json:"mp"`
	RO   bool   `json:"ro"`
}

type sharedFolder struct {
	Node   string        `json:"node"`
	Path   string        `json:"path"`
	Mounts []sharedMount `json:"mounts"`
}

func (s *Server) handleSharedFolders(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		by  = map[string]*sharedFolder{}
		sem = make(chan struct{}, 8)
	)
	for _, g := range res {
		if g.Type != "lxc" || bool(g.Template) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			cfg, err := s.rawConfig(r.Context(), a, g)
			if err != nil {
				return
			}
			for k, v := range cfg {
				if !strings.HasPrefix(k, "mp") || !strings.HasPrefix(v, "/") {
					continue
				}
				o := parseKV(v)
				key := g.Node + "|" + o.first
				mu.Lock()
				f := by[key]
				if f == nil {
					f = &sharedFolder{Node: g.Node, Path: o.first}
					by[key] = f
				}
				f.Mounts = append(f.Mounts, sharedMount{VMID: g.VMID, Name: g.Name, Key: k, MP: o.vals["mp"], RO: o.vals["ro"] == "1"})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	out := []sharedFolder{}
	for _, f := range by {
		slices.SortFunc(f.Mounts, func(x, y sharedMount) int { return x.VMID - y.VMID })
		out = append(out, *f)
	}
	slices.SortFunc(out, func(x, y sharedFolder) int { return cmp.Or(cmp.Compare(x.Node, y.Node), cmp.Compare(x.Path, y.Path)) })
	writeJSON(w, out)
}

package server

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Loja de apps: o catálogo do community-scripts (Proxmox VE Helper-Scripts),
// lido da API pública deles (PocketBase em db.community-scripts.org). O Mia
// só mostra e roda os scripts no console do nó; quem instala é o script deles.

const (
	defaultAppsURL = "https://db.community-scripts.org"
	scriptsRawBase = "https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/"
	appsTTL        = 6 * time.Hour
)

type appNote struct {
	Text string `json:"text"`
	Type string `json:"type"`
}

type appView struct {
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Logo        string    `json:"logo"`
	Type        string    `json:"type"` // lxc | vm | pve | addon | turnkey
	Script      string    `json:"script"`
	ScriptURL   string    `json:"scriptUrl"`
	Port        int       `json:"port"`
	Website     string    `json:"website"`
	Docs        string    `json:"docs"`
	Categories  []string  `json:"categories"`
	ExecuteIn   []string  `json:"executeIn"`
	CPU         int       `json:"cpu"`
	RAM         int       `json:"ram"`  // MB
	Disk        int       `json:"disk"` // GB
	OS          string    `json:"os"`
	OSVersion   string    `json:"osVersion"`
	Privileged  bool      `json:"privileged"`
	Updateable  bool      `json:"updateable"`
	Arm         bool      `json:"arm"`
	DefaultUser string    `json:"defaultUser,omitempty"`
	DefaultPass string    `json:"defaultPass,omitempty"`
	Notes       []appNote `json:"notes"`
	Updated     string    `json:"updated"`
}

type appCategory struct {
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Order int    `json:"order"`
}

type appCatalog struct {
	Apps       []appView     `json:"apps"`
	Categories []appCategory `json:"categories"`
	FetchedAt  time.Time     `json:"fetchedAt"`
}

type appStore struct {
	base string
	path string // cache em disco, pra funcionar se a API cair

	mu  sync.Mutex
	cat *appCatalog
}

func newAppStore(base, dataDir string) *appStore {
	if base == "" {
		base = defaultAppsURL
	}
	st := &appStore{base: base, path: filepath.Join(dataDir, "apps.json")}
	if raw, err := os.ReadFile(st.path); err == nil {
		var c appCatalog
		if json.Unmarshal(raw, &c) == nil && len(c.Apps) > 0 {
			st.cat = &c
		}
	}
	return st
}

// scriptPath segue a mesma regra do gerador do ProxmoxVE-Local.
func scriptPath(typ, slug string) string {
	switch typ {
	case "pve":
		return "tools/pve/" + slug + ".sh"
	case "addon":
		return "tools/addon/" + slug + ".sh"
	case "vm":
		return "vm/" + slug + ".sh"
	case "turnkey":
		return "turnkey/" + slug + ".sh"
	}
	return "ct/" + slug + ".sh"
}

func (st *appStore) get(ctx context.Context, force bool) (*appCatalog, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.cat != nil && !force && time.Since(st.cat.FetchedAt) < appsTTL {
		return st.cat, nil
	}
	c, err := st.fetch(ctx)
	if err != nil {
		if st.cat != nil {
			slog.Warn("apps: usando cache", "err", err)
			return st.cat, nil
		}
		return nil, err
	}
	st.cat = c
	if raw, err := json.Marshal(c); err == nil {
		os.WriteFile(st.path, raw, 0o640)
	}
	return c, nil
}

// flexStr aceita texto ou número (o catálogo mistura os dois em alguns campos).
type flexStr string

func (f *flexStr) UnmarshalJSON(raw []byte) error {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		*f = flexStr(s)
		return nil
	}
	if string(raw) == "null" {
		*f = ""
		return nil
	}
	*f = flexStr(strings.Trim(string(raw), `"`))
	return nil
}

type pbRecord struct {
	Slug           string    `json:"slug"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	Logo           string    `json:"logo"`
	Port           pve.Num   `json:"port"`
	Website        string    `json:"website"`
	Documentation  string    `json:"documentation"`
	ExecuteIn      []string  `json:"execute_in"`
	Privileged     bool      `json:"privileged"`
	Updateable     bool      `json:"updateable"`
	HasArm         bool      `json:"has_arm"`
	IsDev          bool      `json:"is_dev"`
	IsDisabled     bool      `json:"is_disabled"`
	IsDeleted      bool      `json:"is_deleted"`
	DefaultUser    string    `json:"default_user"`
	DefaultPasswd  string    `json:"default_passwd"`
	ScriptUpdated  string    `json:"script_updated"`
	Notes          []appNote `json:"notes"`
	InstallMethods []struct {
		Type      string `json:"type"`
		Resources struct {
			CPU     pve.Num `json:"cpu"`
			RAM     pve.Num `json:"ram"`
			HDD     pve.Num `json:"hdd"`
			OS      flexStr `json:"os"`
			Version flexStr `json:"version"`
		} `json:"resources"`
	} `json:"install_methods"`
	Expand struct {
		Type       struct{ Type string } `json:"type"`
		Categories []struct {
			Name      string `json:"name"`
			Icon      string `json:"icon"`
			SortOrder int    `json:"sort_order"`
		} `json:"categories"`
	} `json:"expand"`
}

func (st *appStore) fetch(ctx context.Context) (*appCatalog, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cat := &appCatalog{FetchedAt: time.Now(), Apps: []appView{}}
	cats := map[string]appCategory{}
	skipped := 0
	for page := 1; ; page++ {
		q := url.Values{
			"page":    {fmt.Sprint(page)},
			"perPage": {"200"},
			"sort":    {"name"},
			"expand":  {"categories,type"},
			"filter":  {"is_deleted=false && is_disabled=false && is_dev=false"},
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, st.base+"/api/collections/script_scripts/records?"+q.Encode(), nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("catálogo: %s", res.Status)
		}
		var body struct {
			Items      []json.RawMessage `json:"items"`
			TotalPages int               `json:"totalPages"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			return nil, fmt.Errorf("catálogo: %w", err)
		}
		for _, item := range body.Items {
			// Um registro torto não derruba a loja inteira.
			var r pbRecord
			if err := json.Unmarshal(item, &r); err != nil {
				skipped++
				continue
			}
			if r.IsDeleted || r.IsDisabled || r.IsDev || r.Slug == "" {
				continue
			}
			typ := r.Expand.Type.Type
			a := appView{
				Slug: r.Slug, Name: r.Name, Description: r.Description, Logo: r.Logo, Type: typ,
				Port: int(r.Port), Website: r.Website, Docs: r.Documentation, ExecuteIn: r.ExecuteIn,
				Privileged: r.Privileged, Updateable: r.Updateable, Arm: r.HasArm,
				DefaultUser: r.DefaultUser, DefaultPass: r.DefaultPasswd, Notes: r.Notes,
				Updated: r.ScriptUpdated, Categories: []string{},
			}
			if a.Notes == nil {
				a.Notes = []appNote{}
			}
			if a.ExecuteIn == nil {
				a.ExecuteIn = []string{}
			}
			a.Script = scriptPath(typ, r.Slug)
			a.ScriptURL = scriptsRawBase + a.Script
			for _, m := range r.InstallMethods {
				if m.Type == "default" || a.CPU == 0 {
					a.CPU, a.RAM, a.Disk = int(m.Resources.CPU), int(m.Resources.RAM), int(m.Resources.HDD)
					a.OS, a.OSVersion = string(m.Resources.OS), string(m.Resources.Version)
				}
			}
			for _, c := range r.Expand.Categories {
				a.Categories = append(a.Categories, c.Name)
				cats[c.Name] = appCategory{Name: c.Name, Icon: c.Icon, Order: c.SortOrder}
			}
			cat.Apps = append(cat.Apps, a)
		}
		if page >= body.TotalPages {
			break
		}
	}
	if len(cat.Apps) == 0 {
		return nil, fmt.Errorf("catálogo vazio")
	}
	if skipped > 0 {
		slog.Warn("apps: registros ignorados", "n", skipped)
	}
	for _, c := range cats {
		cat.Categories = append(cat.Categories, c)
	}
	slices.SortFunc(cat.Categories, func(x, y appCategory) int {
		return cmp.Or(cmp.Compare(x.Order, y.Order), cmp.Compare(x.Name, y.Name))
	})
	return cat, nil
}

func (s *Server) handleApps(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	cat, err := s.apps.get(r.Context(), r.URL.Query().Get("refresh") == "1")
	if err != nil {
		writeErr(w, http.StatusBadGateway, "não consegui baixar o catálogo do community-scripts: "+err.Error())
		return
	}
	writeJSON(w, cat)
}

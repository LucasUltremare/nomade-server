package server

import (
	"cmp"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// "Meus apps": a homepage do homelab. Cada guest vira um card com ícone,
// endereço local e o do Tailscale, e se está respondendo.

type appOverride struct {
	Title  string `json:"title,omitempty"`
	Port   int    `json:"port,omitempty"`
	Scheme string `json:"scheme,omitempty"`
	Path   string `json:"path,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`
}

type myApp struct {
	ID      string `json:"id"`
	VMID    int    `json:"vmid"`
	Type    string `json:"type"`
	Node    string `json:"node"`
	Name    string `json:"name"`
	Title   string `json:"title"`
	Logo    string `json:"logo"`
	Slug    string `json:"slug"` // app do catálogo reconhecido
	Status  string `json:"status"`
	IP      string `json:"ip"`
	TSIP    string `json:"tsIp,omitempty"`
	Port    int    `json:"port"`
	URL     string `json:"url"`
	TSURL   string `json:"tsUrl,omitempty"`
	Up      *bool  `json:"up"` // nil = não deu pra testar
	Latency int    `json:"latency,omitempty"`
	Hidden  bool   `json:"hidden"`
	Scheme  string `json:"scheme"`
	Path    string `json:"path"`
}

// Rede de dentro do guest: LXC pela API, VM pelo agente QEMU.
type guestIPs struct{ lan, ts string }

func pickIPs(ifaces []struct{ name, ip string }) guestIPs {
	var out guestIPs
	for _, i := range ifaces {
		ip := net.ParseIP(i.ip)
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.To4() == nil {
			continue
		}
		switch {
		case strings.HasPrefix(i.name, "tailscale") || (ip[12] == 100 && ip[13] >= 64 && ip[13] < 128):
			out.ts = cmp.Or(out.ts, i.ip)
		case strings.HasPrefix(i.name, "docker") || strings.HasPrefix(i.name, "br-") || strings.HasPrefix(i.name, "veth"):
		default:
			out.lan = cmp.Or(out.lan, i.ip)
		}
	}
	return out
}

func (s *Server) guestIP(ctx context.Context, a pve.Auth, g pve.Resource) guestIPs {
	var list []struct{ name, ip string }
	if g.Status != "running" {
		return guestIPs{}
	}
	if g.Type == "lxc" {
		var raw []struct {
			Name string `json:"name"`
			Inet string `json:"inet"`
		}
		if s.pve.Get(ctx, &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/interfaces", nil, &raw) == nil {
			for _, x := range raw {
				ip, _, _ := strings.Cut(x.Inet, "/")
				list = append(list, struct{ name, ip string }{x.Name, ip})
			}
		}
	} else {
		var raw struct {
			Result []struct {
				Name string `json:"name"`
				IPs  []struct {
					IP   string `json:"ip-address"`
					Type string `json:"ip-address-type"`
				} `json:"ip-addresses"`
			} `json:"result"`
		}
		if s.pve.Get(ctx, &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/agent/network-get-interfaces", nil, &raw) == nil {
			for _, x := range raw.Result {
				for _, ip := range x.IPs {
					list = append(list, struct{ name, ip string }{x.Name, ip.IP})
				}
			}
		}
	}
	return pickIPs(list)
}

// staticIP lê ip=... do net0 do LXC (pra quando ele está desligado).
func staticIP(cfg map[string]string) string {
	o := parseKV(cfg["net0"])
	ip, _, _ := strings.Cut(o.vals["ip"], "/")
	if net.ParseIP(ip) != nil {
		return ip
	}
	return ""
}

// probe testa se a URL responde (qualquer resposta HTTP conta), com cache.
type prober struct {
	mu   sync.Mutex
	last map[string]probeResult
	cl   *http.Client
}

type probeResult struct {
	at      time.Time
	up      bool
	latency int
}

func newProber() *prober {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ResponseHeaderTimeout: 3 * time.Second}
	return &prober{last: map[string]probeResult{}, cl: &http.Client{Transport: tr, Timeout: 4 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (p *prober) check(ctx context.Context, u string) probeResult {
	p.mu.Lock()
	r, ok := p.last[u]
	p.mu.Unlock()
	if ok && time.Since(r.at) < 30*time.Second {
		return r
	}
	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	res, err := p.cl.Do(req)
	r = probeResult{at: time.Now()}
	if err == nil {
		res.Body.Close()
		r.up = res.StatusCode < 500
		r.latency = int(time.Since(start).Milliseconds())
	}
	p.mu.Lock()
	p.last[u] = r
	p.mu.Unlock()
	return r
}

// matchApp acha o app do catálogo pelo nome do guest (o community-scripts
// usa o slug como hostname) ou pelas tags.
func matchApp(cat *appCatalog, name string, tags []string) *appView {
	if cat == nil {
		return nil
	}
	n := strings.ToLower(name)
	cands := append([]string{n}, tags...)
	for _, c := range cands {
		for i := range cat.Apps {
			if cat.Apps[i].Slug == c && cat.Apps[i].Type == "lxc" || cat.Apps[i].Slug == c && cat.Apps[i].Type == "vm" {
				return &cat.Apps[i]
			}
		}
	}
	// "homeassistant" ↔ "home-assistant" etc.
	flat := strings.ReplaceAll(n, "-", "")
	for i := range cat.Apps {
		if a := &cat.Apps[i]; (a.Type == "lxc" || a.Type == "vm") && strings.ReplaceAll(a.Slug, "-", "") == flat {
			return a
		}
	}
	return nil
}

func (s *Server) handleMyApps(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	cat, _ := s.apps.get(r.Context(), false)
	overrides := s.state.appOverrides()
	exposed, tailnet := s.state.exposures()
	all := r.URL.Query().Get("all") == "1"

	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		out = []myApp{}
		sem = make(chan struct{}, 8)
	)
	for _, g := range res {
		if !g.IsGuest() || bool(g.Template) {
			continue
		}
		ov := overrides[strconv.Itoa(g.VMID)]
		if ov.Hidden && !all {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			tags := strings.FieldsFunc(g.Tags, func(c rune) bool { return c == ';' || c == ',' })
			app := myApp{ID: g.ID, VMID: g.VMID, Type: g.Type, Node: g.Node, Name: g.Name, Title: g.Name, Status: g.Status,
				Hidden: ov.Hidden, Scheme: cmp.Or(ov.Scheme, "http"), Path: ov.Path}
			if m := matchApp(cat, g.Name, tags); m != nil {
				app.Slug, app.Logo, app.Port = m.Slug, m.Logo, m.Port
				app.Title = m.Name
			}
			if ov.Title != "" {
				app.Title = ov.Title
			}
			if ov.Port > 0 {
				app.Port = ov.Port
			}
			ips, _ := cached(s.cache, a.User, "ip:"+g.ID, time.Minute, func() (guestIPs, error) {
				return s.guestIP(r.Context(), a, g), nil
			})
			app.IP, app.TSIP = ips.lan, ips.ts
			if app.IP == "" && g.Type == "lxc" {
				if cfg, err := s.rawConfig(r, a, g); err == nil {
					app.IP = staticIP(cfg)
				}
			}
			if app.IP != "" && app.Port > 0 {
				app.URL = fmt.Sprintf("%s://%s:%d%s", app.Scheme, app.IP, app.Port, app.Path)
			}
			host := cmp.Or(exposed[strconv.Itoa(g.VMID)], exposed["name:"+strings.ToLower(g.Name)])
			if host != "" && tailnet != "" {
				app.TSURL = "https://" + host + "." + tailnet + app.Path
			}
			switch {
			case s.cfg.Demo && app.URL != "":
				// No demo os IPs são de mentira: "responde" quem está ligado.
				up := g.Status == "running"
				app.Up, app.Latency = &up, 4+g.VMID%20
			case app.URL != "" && g.Status == "running":
				p := s.prober.check(r.Context(), app.URL)
				app.Up, app.Latency = &p.up, p.latency
			case g.Status != "running":
				down := false
				app.Up = &down
			}
			mu.Lock()
			out = append(out, app)
			mu.Unlock()
		}()
	}
	wg.Wait()
	// Apps reconhecidos e com endereço primeiro; depois o resto, por nome.
	rank := func(x myApp) int {
		switch {
		case x.URL != "":
			return 0
		case x.Slug != "":
			return 1
		}
		return 2
	}
	slices.SortFunc(out, func(x, y myApp) int {
		return cmp.Or(cmp.Compare(rank(x), rank(y)), cmp.Compare(strings.ToLower(x.Title), strings.ToLower(y.Title)))
	})
	writeJSON(w, out)
}

func (s *Server) handleMyAppSave(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	vmid, err := strconv.Atoi(r.PathValue("vmid"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "guest inválido")
		return
	}
	var ov appOverride
	if err := readJSON(r, &ov); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	if ov.Port < 0 || ov.Port > 65535 || (ov.Scheme != "" && ov.Scheme != "http" && ov.Scheme != "https") ||
		(ov.Path != "" && !strings.HasPrefix(ov.Path, "/")) || len(ov.Title) > 64 || strings.ContainsAny(ov.Path, " \"<>") {
		writeErr(w, http.StatusBadRequest, "porta, protocolo ou caminho inválidos")
		return
	}
	if _, err := url.Parse(ov.Path); err != nil {
		writeErr(w, http.StatusBadRequest, "caminho inválido")
		return
	}
	if err := s.state.setAppOverride(strconv.Itoa(vmid), ov); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

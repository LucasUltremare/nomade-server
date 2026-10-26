// Package server é o backend HTTP do Mia: serve o frontend embutido e uma API
// JSON que agrega e traduz a API do Proxmox pra o que as telas precisam.
package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
	"github.com/LucasUltremare/nomade-server/web"
)

type Config struct {
	Listen  string // :8443
	PVEURL  string // https://127.0.0.1:8006
	DataDir string // /var/lib/mia
	Version string
	Demo    bool
	AppsURL string // API do catálogo do community-scripts (vazio = a pública)
	Token   string // token de API da Mia pros agendamentos ("mia@pve!mia=…")
	// Certificados TLS; vazio = tenta os do PVE e, se não der, gera um próprio.
	CertFile string
	KeyFile  string
}

type Server struct {
	cfg      Config
	pve      *pve.Client
	sessions *sessionStore
	limiter  *limiter
	state    *state
	cache    *cache
	ts       *tailscale
	apps     *appStore
	updater  *updater
	prober   *prober
	sched    *scheduler
}

func New(cfg Config) (*Server, error) {
	c, err := pve.New(cfg.PVEURL)
	if err != nil {
		return nil, err
	}
	st, err := loadState(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	srv := &Server{
		cfg:      cfg,
		pve:      c,
		sessions: newSessionStore(),
		limiter:  &limiter{hits: map[string][]time.Time{}},
		state:    st,
		cache:    newCache(),
		ts:       &tailscale{demo: cfg.Demo},
		apps:     newAppStore(cfg.AppsURL, cfg.DataDir),
		updater:  newUpdater(cfg.Version),
		prober:   newProber(),
	}
	srv.sched = &scheduler{s: srv, running: map[string]bool{}}
	return srv, nil
}

func (s *Server) Run(ctx context.Context) error {
	certs, err := newCertSource(s.cfg)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              s.cfg.Listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// Só HTTP/1.1: o proxy de websocket do console depende do Upgrade clássico.
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
		TLSConfig: &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: certs.get,
		},
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shut)
	}()
	go s.sched.loop(ctx)
	slog.Info("mia no ar", "listen", s.cfg.Listen, "pve", s.cfg.PVEURL, "demo", s.cfg.Demo, "token", s.cfg.Token != "")
	if err := srv.ListenAndServeTLS("", ""); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/meta", s.handleMeta)
	mux.HandleFunc("GET /api/realms", s.handleRealms)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/login/tfa", s.handleTFA)
	mux.HandleFunc("POST /api/logout", s.handleLogout)

	mux.HandleFunc("GET /api/me", s.authed(s.handleMe))
	mux.HandleFunc("GET /api/status", s.authed(s.handleStatus))
	mux.HandleFunc("GET /api/overview", s.authed(s.handleOverview))
	mux.HandleFunc("GET /api/guests", s.authed(s.handleGuests))
	mux.HandleFunc("GET /api/nodes/{node}", s.authed(s.handleNode))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/{action}", s.authed(s.handleGuestAction))
	mux.HandleFunc("GET /api/backup/storages", s.authed(s.handleBackupStorages))
	mux.HandleFunc("POST /api/backup", s.authed(s.handleBackup))
	mux.HandleFunc("PUT /api/favorites", s.authed(s.handleFavorites))

	mux.HandleFunc("GET /api/tasks", s.authed(s.handleTaskList))
	mux.HandleFunc("GET /api/tasks/{upid}", s.authed(s.handleTask))
	mux.HandleFunc("DELETE /api/tasks/{upid}", s.authed(s.handleTaskStop))

	mux.HandleFunc("GET /api/guests/{kind}/{vmid}/config", s.authed(s.handleGuestConfig))
	mux.HandleFunc("PUT /api/guests/{kind}/{vmid}/resources", s.authed(s.handleGuestResources))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/disks/resize", s.authed(s.handleDiskResize))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/disks/add", s.authed(s.handleDiskAdd))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/disks/move", s.authed(s.handleDiskMove))
	mux.HandleFunc("DELETE /api/guests/{kind}/{vmid}/disks/{disk}", s.authed(s.handleDiskRemove))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/migrate", s.authed(s.handleMigrate))
	mux.HandleFunc("GET /api/guests/{kind}/{vmid}/snapshots", s.authed(s.handleSnapshots))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/snapshots", s.authed(s.handleSnapshotCreate))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/snapshots/{snap}/rollback", s.authed(s.handleSnapshotRollback))
	mux.HandleFunc("DELETE /api/guests/{kind}/{vmid}/snapshots/{snap}", s.authed(s.handleSnapshotDelete))
	mux.HandleFunc("GET /api/guests/{kind}/{vmid}/rrd", s.authed(s.handleGuestRRD))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/clone", s.authed(s.handleClone))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/template", s.authed(s.handleTemplate))
	mux.HandleFunc("PUT /api/guests/{kind}/{vmid}/cdrom", s.authed(s.handleCDROM))
	mux.HandleFunc("DELETE /api/guests/{kind}/{vmid}", s.authed(s.handleDestroy))
	mux.HandleFunc("PUT /api/guests/{kind}/{vmid}/options", s.authed(s.handleGuestOptions))
	mux.HandleFunc("PUT /api/guests/{kind}/{vmid}/net/{net}", s.authed(s.handleGuestNet))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/devices", s.authed(s.handleGuestDevice))
	mux.HandleFunc("DELETE /api/guests/{kind}/{vmid}/config/{key}", s.authed(s.handleConfigKeyDelete))
	mux.HandleFunc("PUT /api/guests/{kind}/{vmid}/disks/{disk}/options", s.authed(s.handleDiskOptions))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/power/{power}", s.authed(s.handleGuestPower))
	mux.HandleFunc("GET /api/guests/{kind}/{vmid}/tasks", s.authed(s.handleGuestTasks))
	mux.HandleFunc("GET /api/guests/{kind}/{vmid}/backups", s.authed(s.handleGuestBackups))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/backup", s.authed(s.handleGuestBackupNow))
	mux.HandleFunc("POST /api/guests/{kind}/{vmid}/restore", s.authed(s.handleGuestRestoreOver))
	mux.HandleFunc("GET /api/nodes/{node}/hardware", s.authed(s.handleHardware))
	mux.HandleFunc("POST /api/nodes/{node}/bulk/{op}", s.authed(s.handleNodeBulk))
	mux.HandleFunc("GET /api/nodes/{node}/repos", s.authed(s.handleRepos))
	mux.HandleFunc("POST /api/nodes/{node}/repos", s.authed(s.handleRepoChange))
	mux.HandleFunc("GET /api/myapps", s.authed(s.handleMyApps))
	mux.HandleFunc("PUT /api/myapps/{vmid}", s.authed(s.handleMyAppSave))
	mux.HandleFunc("GET /api/nodes/{node}/vm-options", s.authed(s.handleVMOptions))
	mux.HandleFunc("POST /api/nodes/{node}/qemu", s.authed(s.handleVMCreate))

	mux.HandleFunc("GET /api/health", s.authed(s.handleHealth))
	mux.HandleFunc("POST /api/nodes/{node}/apt/refresh", s.authed(s.handleAptRefresh))

	mux.HandleFunc("GET /api/backup/jobs", s.authed(s.handleJobs))
	mux.HandleFunc("POST /api/backup/jobs", s.authed(s.handleJobSave))
	mux.HandleFunc("PUT /api/backup/jobs/{id}", s.authed(s.handleJobSave))
	mux.HandleFunc("DELETE /api/backup/jobs/{id}", s.authed(s.handleJobDelete))
	mux.HandleFunc("POST /api/backup/jobs/{id}/run", s.authed(s.handleJobRun))
	mux.HandleFunc("GET /api/backup/status", s.authed(s.handleBackupStatus))

	mux.HandleFunc("GET /api/firewall", s.authed(s.handleFirewall))
	mux.HandleFunc("PUT /api/firewall/options", s.authed(s.handleFirewallOptions))
	mux.HandleFunc("POST /api/firewall/rules", s.authed(s.handleFirewallRuleAdd))
	mux.HandleFunc("PUT /api/firewall/rules/{pos}", s.authed(s.handleFirewallRuleToggle))
	mux.HandleFunc("DELETE /api/firewall/rules/{pos}", s.authed(s.handleFirewallRuleDelete))
	mux.HandleFunc("GET /api/firewall/macros", s.authed(s.handleFirewallMacros))
	mux.HandleFunc("POST /api/console", s.authed(s.handleConsoleOpen))
	mux.HandleFunc("GET /api/console/ws", s.authed(s.handleConsoleWS))
	mux.HandleFunc("GET /api/apps", s.authed(s.handleApps))

	mux.HandleFunc("GET /api/nodes/{node}/lxc-options", s.authed(s.handleLXCOptions))
	mux.HandleFunc("POST /api/nodes/{node}/templates", s.authed(s.handleTemplateDownload))
	mux.HandleFunc("POST /api/nodes/{node}/lxc", s.authed(s.handleLXCCreate))

	mux.HandleFunc("GET /api/nodes/{node}/network", s.authed(s.handleNetwork))
	mux.HandleFunc("POST /api/nodes/{node}/network", s.authed(s.handleNetworkCreate))
	mux.HandleFunc("DELETE /api/nodes/{node}/network/{iface}", s.authed(s.handleNetworkDelete))
	mux.HandleFunc("POST /api/nodes/{node}/network/{op}", s.authed(s.handleNetworkApply))

	mux.HandleFunc("GET /api/storage", s.authed(s.handleStorageList))
	mux.HandleFunc("GET /api/storage/{node}/{storage}/content", s.authed(s.handleStorageContent))
	mux.HandleFunc("DELETE /api/storage/{node}/{storage}/content", s.authed(s.handleVolumeDelete))
	mux.HandleFunc("POST /api/storage/{node}/{storage}/upload", s.authed(s.handleUpload))
	mux.HandleFunc("POST /api/storage/{node}/{storage}/download-url", s.authed(s.handleDownloadURL))
	mux.HandleFunc("POST /api/nodes/{node}/restore", s.authed(s.handleRestore))

	mux.HandleFunc("GET /api/settings", s.authed(s.handleSettings))
	mux.HandleFunc("PUT /api/settings/tailscale", s.authed(s.handleTailscaleKey))
	mux.HandleFunc("POST /api/tailscale/command", s.authed(s.handleTailscaleCommand))
	mux.HandleFunc("GET /api/update", s.authed(s.handleUpdateInfo))

	s.fwdRoutes(mux, mustRoutes(pveRoutes()))
	mux.HandleFunc("GET /api/shared-folders", s.authed(s.handleSharedFolders))
	mux.HandleFunc("GET /api/jobs", s.authed(s.handleJobsList))
	mux.HandleFunc("POST /api/jobs", s.authed(s.handleJobsSave))
	mux.HandleFunc("DELETE /api/jobs/{id}", s.authed(s.handleJobsDelete))
	mux.HandleFunc("POST /api/jobs/{id}/run", s.authed(s.handleJobsRun))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "rota não existe")
	})
	mux.Handle("/", s.static())
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Referrer-Policy", "same-origin")
		hd.Set("Strict-Transport-Security", "max-age=31536000")
		h.ServeHTTP(w, r)
	})
}

// static serve o build do Vite; rotas desconhecidas caem no index.html (SPA).
func (s *Server) static() http.Handler {
	dist, _ := fs.Sub(web.Dist, "dist")
	files := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" {
			if _, err := fs.Stat(dist, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "frontend não compilado: rode `make web` antes do build", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}

type authedHandler func(w http.ResponseWriter, r *http.Request, a pve.Auth)

// authed exige sessão completa e, em escrita, o header X-Mia (o SameSite já
// barra CSRF, isso é a segunda tranca).
func (s *Server) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := s.sessions.get(r)
		if sess == nil || sess.pendingTFA {
			writeErr(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("X-Mia") != "1" {
			writeErr(w, http.StatusForbidden, "requisição sem X-Mia")
			return
		}
		a, err := sess.current(r.Context(), s.pve)
		if err != nil {
			s.sessions.drop(sess.id)
			clearSessionCookie(w)
			writeErr(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		h(w, r, a)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// writePVEErr traduz um erro da API do PVE pra resposta do Mia.
func writePVEErr(w http.ResponseWriter, err error) {
	var pe *pve.Error
	if errors.As(err, &pe) {
		status := pe.Status
		if status == http.StatusUnauthorized {
			// Ticket válido mas sem permissão vira 403 pro front não deslogar.
			status = http.StatusForbidden
		}
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		writeErr(w, status, pe.Msg)
		return
	}
	slog.Error("pve", "err", err)
	writeErr(w, http.StatusBadGateway, "não consegui falar com o Proxmox: "+err.Error())
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// --- auth ---

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"version": s.cfg.Version, "demo": s.cfg.Demo})
}

func (s *Server) handleRealms(w http.ResponseWriter, r *http.Request) {
	realms, err := s.pve.Realms(r.Context())
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, realms)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.limiter.blocked(ip) {
		writeErr(w, http.StatusTooManyRequests, "muitas tentativas, espera um minuto")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Realm    string `json:"realm"`
	}
	if err := readJSON(r, &body); err != nil || body.Username == "" || body.Password == "" {
		writeErr(w, http.StatusBadRequest, "usuário e senha obrigatórios")
		return
	}
	user := body.Username
	if !strings.Contains(user, "@") {
		realm := body.Realm
		if realm == "" {
			realm = "pam"
		}
		user += "@" + realm
	}
	res, err := s.pve.Login(r.Context(), user, body.Password)
	if err != nil {
		if pve.IsAuth(err) {
			s.limiter.fail(ip)
			writeErr(w, http.StatusUnauthorized, "usuário ou senha inválidos")
			return
		}
		writePVEErr(w, err)
		return
	}
	sess := s.sessions.create(res.Auth, res.NeedTFA)
	setSessionCookie(w, sess.id)
	writeJSON(w, map[string]any{"user": res.Auth.User, "needTfa": res.NeedTFA})
}

func (s *Server) handleTFA(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.limiter.blocked(ip) {
		writeErr(w, http.StatusTooManyRequests, "muitas tentativas, espera um minuto")
		return
	}
	sess := s.sessions.get(r)
	if sess == nil || !sess.pendingTFA {
		writeErr(w, http.StatusUnauthorized, "faça login de novo")
		return
	}
	var body struct {
		Code string `json:"code"`
		Kind string `json:"kind"` // totp | recovery | yubico
	}
	if err := readJSON(r, &body); err != nil || body.Code == "" {
		writeErr(w, http.StatusBadRequest, "código obrigatório")
		return
	}
	kind := body.Kind
	if kind == "" {
		kind = "totp"
	}
	sess.mu.Lock()
	challenge := sess.auth
	sess.mu.Unlock()
	a, err := s.pve.CompleteTFA(r.Context(), challenge.User, challenge.Ticket, kind+":"+strings.TrimSpace(body.Code))
	if err != nil {
		if pve.IsAuth(err) {
			s.limiter.fail(ip)
			writeErr(w, http.StatusUnauthorized, "código inválido")
			return
		}
		writePVEErr(w, err)
		return
	}
	s.sessions.drop(sess.id)
	full := s.sessions.create(a, false)
	setSessionCookie(w, full.id)
	writeJSON(w, map[string]any{"user": a.User})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if sess := s.sessions.get(r); sess != nil {
		s.sessions.drop(sess.id)
	}
	clearSessionCookie(w)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	writeJSON(w, map[string]any{"user": a.User, "favorites": s.state.favorites(a.User)})
}

// --- guests ---

func (s *Server) handleGuests(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	out := []guestView{}
	for _, g := range res {
		if g.IsGuest() {
			out = append(out, toGuest(g))
		}
	}
	slices.SortFunc(out, func(x, y guestView) int { return x.VMID - y.VMID })
	writeJSON(w, out)
}

var guestActions = []string{"start", "shutdown", "stop", "reboot", "suspend", "resume"}

func (s *Server) handleGuestAction(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	kind, action := r.PathValue("kind"), r.PathValue("action")
	vmid, err := strconv.Atoi(r.PathValue("vmid"))
	if err != nil || (kind != "qemu" && kind != "lxc") || !slices.Contains(guestActions, action) {
		writeErr(w, http.StatusBadRequest, "ação inválida")
		return
	}
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	i := slices.IndexFunc(res, func(g pve.Resource) bool { return g.Type == kind && g.VMID == vmid })
	if i < 0 {
		writeErr(w, http.StatusNotFound, "guest não encontrado")
		return
	}
	upid, err := s.pve.GuestAction(r.Context(), &a, res[i].Node, kind, vmid, action)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleFavorites(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	if len(body.IDs) > 50 {
		body.IDs = body.IDs[:50]
	}
	if err := s.state.setFavorites(a.User, body.IDs); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"favorites": s.state.favorites(a.User)})
}

// --- backup ---

type backupStorage struct {
	Storage string   `json:"storage"`
	Type    string   `json:"type"`
	Shared  bool     `json:"shared"`
	Avail   pve.Int  `json:"avail"`
	Total   pve.Int  `json:"total"`
	Nodes   []string `json:"nodes"`
}

func (s *Server) handleBackupStorages(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	nodes, err := s.onlineNodes(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	byName := map[string]*backupStorage{}
	var order []string
	for _, n := range nodes {
		list, err := s.pve.NodeStorage(r.Context(), &a, n, "backup")
		if err != nil {
			continue
		}
		for _, st := range list {
			if !st.Active {
				continue
			}
			b := byName[st.Storage]
			if b == nil {
				b = &backupStorage{Storage: st.Storage, Type: st.Type, Shared: bool(st.Shared), Avail: st.Avail, Total: st.Total}
				byName[st.Storage] = b
				order = append(order, st.Storage)
			}
			b.Nodes = append(b.Nodes, n)
		}
	}
	out := []backupStorage{}
	for _, name := range order {
		out = append(out, *byName[name])
	}
	writeJSON(w, map[string]any{"storages": out, "nodes": nodes})
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		Storage string `json:"storage"`
		Mode    string `json:"mode"`
	}
	if err := readJSON(r, &body); err != nil || body.Storage == "" {
		writeErr(w, http.StatusBadRequest, "escolha um storage")
		return
	}
	if !slices.Contains([]string{"snapshot", "suspend", "stop"}, body.Mode) {
		body.Mode = "snapshot"
	}
	nodes, err := s.onlineNodes(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	type result struct {
		Node  string `json:"node"`
		UPID  string `json:"upid,omitempty"`
		Error string `json:"error,omitempty"`
	}
	out := []result{}
	for _, n := range nodes {
		upid, err := s.pve.Vzdump(r.Context(), &a, n, url.Values{
			"all":      {"1"},
			"storage":  {body.Storage},
			"mode":     {body.Mode},
			"compress": {"zstd"},
		})
		res := result{Node: n, UPID: upid}
		if err != nil {
			res.Error = err.Error()
		}
		out = append(out, res)
	}
	writeJSON(w, map[string]any{"tasks": out})
}

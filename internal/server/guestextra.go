package server

import (
	"cmp"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Ações que faltavam (hibernar, resetar, tudo do nó), backups e tarefas de um
// guest só, repositórios do apt e atualização do nó.

// handleGuestPower cobre o que não é o /status/{action} direto do PVE.
func (s *Server) handleGuestPower(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	action := r.PathValue("power")
	path := pve.GuestPath(g.Node, g.Type, g.VMID) + "/status/"
	f := url.Values{}
	switch {
	case action == "hibernate" && g.Type == "qemu":
		path += "suspend"
		f.Set("todisk", "1")
	case action == "reset" && g.Type == "qemu":
		path += "reset"
	default:
		writeErr(w, http.StatusBadRequest, "ação inválida")
		return
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, path, f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

// handleNodeBulk liga ou desliga todos os guests do nó (respeitando a ordem
// de boot configurada).
func (s *Server) handleNodeBulk(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	op := r.PathValue("op")
	if op != "startall" && op != "stopall" {
		writeErr(w, http.StatusBadRequest, "ação inválida")
		return
	}
	f := url.Values{}
	if op == "startall" {
		f.Set("force", "1") // inclui quem não tem "iniciar com o nó"
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/"+op, f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleGuestTasks(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var raw []taskRow
	q := url.Values{"vmid": {strconv.Itoa(g.VMID)}, "limit": {"50"}, "source": {"all"}}
	if err := s.pve.Get(r.Context(), &a, "/nodes/"+url.PathEscape(g.Node)+"/tasks", q, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	if raw == nil {
		raw = []taskRow{}
	}
	slices.SortFunc(raw, func(x, y taskRow) int { return cmp.Compare(y.StartTime, x.StartTime) })
	writeJSON(w, raw)
}

type guestBackupFile struct {
	Volid   string  `json:"volid"`
	Storage string  `json:"storage"`
	Node    string  `json:"node"`
	Size    pve.Int `json:"size"`
	CTime   pve.Int `json:"ctime"`
	Notes   string  `json:"notes"`
}

// handleGuestBackups lista os backups desse guest em todos os storages de backup.
func (s *Server) handleGuestBackups(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var (
		mu   sync.Mutex
		wg   sync.WaitGroup
		out  = []guestBackupFile{}
		seen = map[string]bool{}
	)
	for _, st := range res {
		if st.Type != "storage" || st.Status != "available" || !hasContent(st.Content, "backup") {
			continue
		}
		key := st.Node + "/" + st.Storage
		if st.Shared {
			key = st.Storage
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			var vols []guestBackupFile
			path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(st.Node), url.PathEscape(st.Storage))
			q := url.Values{"content": {"backup"}, "vmid": {strconv.Itoa(g.VMID)}}
			if s.pve.Get(r.Context(), &a, path, q, &vols) != nil {
				return
			}
			mu.Lock()
			for _, v := range vols {
				v.Storage, v.Node = st.Storage, st.Node
				out = append(out, v)
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	slices.SortFunc(out, func(x, y guestBackupFile) int { return cmp.Compare(y.CTime, x.CTime) })
	writeJSON(w, out)
}

func (s *Server) handleGuestBackupNow(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Storage string `json:"storage"`
		Mode    string `json:"mode"`
		Notes   string `json:"notes"`
	}
	if err := readJSON(r, &body); err != nil || body.Storage == "" {
		writeErr(w, http.StatusBadRequest, "escolha o storage")
		return
	}
	if !slices.Contains([]string{"snapshot", "suspend", "stop"}, body.Mode) {
		body.Mode = "snapshot"
	}
	f := url.Values{"vmid": {strconv.Itoa(g.VMID)}, "storage": {body.Storage}, "mode": {body.Mode}, "compress": {"zstd"}}
	if body.Notes != "" {
		f.Set("notes-template", strings.ReplaceAll(body.Notes, "\n", " "))
	}
	upid, err := s.pve.Vzdump(r.Context(), &a, g.Node, f)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// handleGuestRestoreOver volta o guest pra um backup, sobrescrevendo (como o
// "Restore" da aba Backup do PVE). Pede o nome digitado.
func (s *Server) handleGuestRestoreOver(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Volid   string `json:"volid"`
		Confirm string `json:"confirm"`
	}
	if err := readJSON(r, &body); err != nil || body.Volid == "" {
		writeErr(w, http.StatusBadRequest, "escolha o backup")
		return
	}
	if body.Confirm != g.Name {
		writeErr(w, http.StatusBadRequest, "digite o nome do guest pra confirmar")
		return
	}
	if g.Status == "running" {
		writeErr(w, http.StatusConflict, "desligue o guest antes de restaurar por cima")
		return
	}
	f := url.Values{"vmid": {strconv.Itoa(g.VMID)}, "force": {"1"}}
	if g.Type == "lxc" {
		f.Set("ostemplate", body.Volid)
		f.Set("restore", "1")
	} else {
		f.Set("archive", body.Volid)
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(g.Node)+"/"+g.Type, f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

// --- repositórios ---

func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var out map[string]any
	if err := s.pve.Get(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/apt/repositories", nil, &out); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, out)
}

// handleRepoChange liga/desliga uma linha (path+index) ou adiciona um
// repositório padrão (handle: no-subscription, enterprise, test...).
func (s *Server) handleRepoChange(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	var body struct {
		Handle  string `json:"handle"`
		Path    string `json:"path"`
		Index   int    `json:"index"`
		Enabled bool   `json:"enabled"`
		Digest  string `json:"digest"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	path := "/nodes/" + url.PathEscape(r.PathValue("node")) + "/apt/repositories"
	var err error
	if body.Handle != "" {
		f := url.Values{"handle": {body.Handle}}
		if body.Digest != "" {
			f.Set("digest", body.Digest)
		}
		err = s.pve.Put(r.Context(), &a, path, f, nil)
	} else {
		if !strings.HasPrefix(body.Path, "/etc/apt/") {
			writeErr(w, http.StatusBadRequest, "arquivo inválido")
			return
		}
		f := url.Values{"path": {body.Path}, "index": {strconv.Itoa(body.Index)}, "enabled": {b01(body.Enabled)}}
		if body.Digest != "" {
			f.Set("digest", body.Digest)
		}
		err = s.pve.Post(r.Context(), &a, path, f, nil)
	}
	if err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]bool{"ok": true})
}

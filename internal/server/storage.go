package server

import (
	"cmp"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Armazenamento: storages de cada nó e o que tem dentro deles (ISOs,
// templates, backups, discos), com upload, download por URL, exclusão e
// restauração de backup.

type storageRow struct {
	Node    string   `json:"node"`
	Storage string   `json:"storage"`
	Type    string   `json:"type"`
	Content []string `json:"content"`
	Used    pve.Int  `json:"used"`
	Total   pve.Int  `json:"total"`
	Avail   pve.Int  `json:"avail"`
	Shared  bool     `json:"shared"`
	Active  bool     `json:"active"`
}

func (s *Server) handleStorageList(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	nodes, err := s.onlineNodes(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var (
		mu   sync.Mutex
		wg   sync.WaitGroup
		rows = []storageRow{}
	)
	for _, n := range nodes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			list, err := s.pve.NodeStorage(r.Context(), &a, n, "")
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, st := range list {
				if !st.Enabled {
					continue
				}
				rows = append(rows, storageRow{Node: n, Storage: st.Storage, Type: st.Type,
					Content: strings.Split(st.Content, ","), Used: st.Used, Total: st.Total, Avail: st.Avail,
					Shared: bool(st.Shared), Active: bool(st.Active)})
			}
		}()
	}
	wg.Wait()
	slices.SortFunc(rows, func(x, y storageRow) int {
		return cmp.Or(cmp.Compare(x.Node, y.Node), cmp.Compare(x.Storage, y.Storage))
	})
	writeJSON(w, map[string]any{"storages": rows, "nodes": nodes})
}

type volumeView struct {
	Volid     string  `json:"volid"`
	Name      string  `json:"name"`
	Content   string  `json:"content"`
	Subtype   string  `json:"subtype"` // backups: lxc | qemu
	Format    string  `json:"format"`
	Size      pve.Int `json:"size"`
	CTime     pve.Int `json:"ctime"`
	VMID      int     `json:"vmid"`
	Notes     string  `json:"notes"`
	Protected bool    `json:"protected"`
}

func storagePath(r *http.Request) string {
	return fmt.Sprintf("/nodes/%s/storage/%s", url.PathEscape(r.PathValue("node")), url.PathEscape(r.PathValue("storage")))
}

func (s *Server) handleStorageContent(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var q url.Values
	if c := r.URL.Query().Get("content"); c != "" {
		q = url.Values{"content": {c}}
	}
	var raw []struct {
		Volid     string   `json:"volid"`
		Content   string   `json:"content"`
		Subtype   string   `json:"subtype"`
		Format    string   `json:"format"`
		Size      pve.Int  `json:"size"`
		CTime     pve.Int  `json:"ctime"`
		VMID      pve.Num  `json:"vmid"`
		Notes     string   `json:"notes"`
		Protected pve.Bool `json:"protected"`
	}
	if err := s.pve.Get(r.Context(), &a, storagePath(r)+"/content", q, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	out := []volumeView{}
	for _, v := range raw {
		name := v.Volid
		if i := strings.Index(name, ":"); i >= 0 {
			name = name[i+1:]
		}
		name = path.Base(name)
		sub := v.Subtype
		if sub == "" && v.Content == "backup" {
			// PBS (backup/vm/...) e vzdump (vzdump-qemu-...) dizem no nome.
			sub = "lxc"
			if strings.Contains(v.Volid, "backup/vm/") || strings.Contains(v.Volid, "vzdump-qemu-") {
				sub = "qemu"
			}
		}
		out = append(out, volumeView{Volid: v.Volid, Name: name, Content: v.Content, Subtype: sub, Format: v.Format, Size: v.Size,
			CTime: v.CTime, VMID: int(v.VMID), Notes: v.Notes, Protected: bool(v.Protected)})
	}
	slices.SortFunc(out, func(x, y volumeView) int {
		return cmp.Or(cmp.Compare(y.CTime, x.CTime), cmp.Compare(x.Name, y.Name))
	})
	writeJSON(w, out)
}

func (s *Server) handleVolumeDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	volid := r.URL.Query().Get("volid")
	if volid == "" {
		writeErr(w, http.StatusBadRequest, "volid obrigatório")
		return
	}
	var upid string
	if err := s.pve.Delete(r.Context(), &a, storagePath(r)+"/content/"+url.PathEscape(volid), nil, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

var fileNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$`)

func uploadContent(c string) bool { return c == "iso" || c == "vztmpl" || c == "import" }

// handleUpload recebe o arquivo cru no corpo (o front manda nome e tipo nos
// headers) e repassa pro PVE em streaming.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	name := r.Header.Get("X-Filename")
	content := r.Header.Get("X-Content")
	if !fileNameRe.MatchString(name) || !uploadContent(content) {
		writeErr(w, http.StatusBadRequest, "nome de arquivo ou tipo inválido")
		return
	}
	if r.ContentLength <= 0 {
		writeErr(w, http.StatusLengthRequired, "tamanho do arquivo desconhecido")
		return
	}
	upid, err := s.pve.Upload(r.Context(), &a, storagePath(r)+"/upload",
		map[string]string{"content": content}, name, r.Body, r.ContentLength)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleDownloadURL(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		URL      string `json:"url"`
		Filename string `json:"filename"`
		Content  string `json:"content"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	u, err := url.Parse(body.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		writeErr(w, http.StatusBadRequest, "URL inválida")
		return
	}
	if body.Filename == "" {
		body.Filename = path.Base(u.Path)
	}
	if !fileNameRe.MatchString(body.Filename) || !uploadContent(body.Content) {
		writeErr(w, http.StatusBadRequest, "nome de arquivo ou tipo inválido")
		return
	}
	var upid string
	err = s.pve.Post(r.Context(), &a, storagePath(r)+"/download-url",
		url.Values{"url": {body.URL}, "filename": {body.Filename}, "content": {body.Content}}, &upid)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// handleRestore cria um guest novo a partir de um backup (nunca sobrescreve).
func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		Volid   string `json:"volid"`
		Kind    string `json:"kind"` // lxc | qemu
		Storage string `json:"storage"`
		VMID    int    `json:"vmid"`
		Start   bool   `json:"start"`
	}
	if err := readJSON(r, &body); err != nil || body.Volid == "" || body.Storage == "" {
		writeErr(w, http.StatusBadRequest, "backup e storage de destino obrigatórios")
		return
	}
	if body.Kind != "lxc" && body.Kind != "qemu" {
		writeErr(w, http.StatusBadRequest, "tipo inválido")
		return
	}
	if body.VMID == 0 {
		id, err := s.pve.NextID(r.Context(), &a)
		if err != nil {
			writePVEErr(w, err)
			return
		}
		body.VMID = id
	}
	f := url.Values{"vmid": {strconv.Itoa(body.VMID)}, "storage": {body.Storage}, "start": {b01(body.Start)}}
	if body.Kind == "lxc" {
		f.Set("ostemplate", body.Volid)
		f.Set("restore", "1")
	} else {
		f.Set("archive", body.Volid)
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/"+body.Kind, f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]any{"upid": upid, "vmid": body.VMID})
}

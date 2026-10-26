package server

import (
	"cmp"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Jobs de backup agendados (/cluster/backup) e o estado de cada guest:
// último backup encontrado nos storages e se algum job cobre ele.

type retention struct {
	Last    int `json:"last"`
	Daily   int `json:"daily"`
	Weekly  int `json:"weekly"`
	Monthly int `json:"monthly"`
	Yearly  int `json:"yearly"`
}

type backupJob struct {
	ID        string    `json:"id"`
	Enabled   bool      `json:"enabled"`
	Schedule  string    `json:"schedule"`
	Storage   string    `json:"storage"`
	Mode      string    `json:"mode"`
	Compress  string    `json:"compress"`
	All       bool      `json:"all"`
	VMIDs     []int     `json:"vmids"`
	Exclude   []int     `json:"exclude"`
	Node      string    `json:"node"`
	Retention retention `json:"retention"`
	Comment   string    `json:"comment"`
	NextRun   int64     `json:"nextRun"`
}

func parseIDs(s string) []int {
	out := []int{}
	for _, p := range strings.Split(s, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func joinIDs(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	return strings.Join(parts, ",")
}

// parseRetention aceita "keep-last=3,keep-daily=7" ou o objeto que o PVE 8+ manda.
func parseRetention(raw json.RawMessage) retention {
	var r retention
	set := func(k string, v int) {
		switch k {
		case "keep-last":
			r.Last = v
		case "keep-daily":
			r.Daily = v
		case "keep-weekly":
			r.Weekly = v
		case "keep-monthly":
			r.Monthly = v
		case "keep-yearly":
			r.Yearly = v
		}
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		for _, p := range strings.Split(str, ",") {
			if k, v, ok := strings.Cut(p, "="); ok {
				n, _ := strconv.Atoi(v)
				set(k, n)
			}
		}
		return r
	}
	var obj map[string]pve.Num
	if json.Unmarshal(raw, &obj) == nil {
		for k, v := range obj {
			set(k, int(v))
		}
	}
	return r
}

func (r retention) String() string {
	var parts []string
	for _, p := range []struct {
		k string
		v int
	}{{"keep-last", r.Last}, {"keep-daily", r.Daily}, {"keep-weekly", r.Weekly}, {"keep-monthly", r.Monthly}, {"keep-yearly", r.Yearly}} {
		if p.v > 0 {
			parts = append(parts, fmt.Sprintf("%s=%d", p.k, p.v))
		}
	}
	if len(parts) == 0 {
		return "keep-all=1"
	}
	return strings.Join(parts, ",")
}

func (s *Server) listJobs(r *http.Request, a pve.Auth) ([]backupJob, error) {
	var raw []struct {
		ID       string          `json:"id"`
		Enabled  *pve.Bool       `json:"enabled"`
		Schedule string          `json:"schedule"`
		Storage  string          `json:"storage"`
		Mode     string          `json:"mode"`
		Compress string          `json:"compress"`
		All      pve.Bool        `json:"all"`
		VMID     flexStr         `json:"vmid"`
		Exclude  flexStr         `json:"exclude"`
		Node     string          `json:"node"`
		Prune    json.RawMessage `json:"prune-backups"`
		Comment  string          `json:"comment"`
		NextRun  pve.Num         `json:"next-run"`
	}
	if err := s.pve.Get(r.Context(), &a, "/cluster/backup", nil, &raw); err != nil {
		return nil, err
	}
	out := []backupJob{}
	for _, j := range raw {
		out = append(out, backupJob{
			ID: j.ID, Enabled: j.Enabled == nil || bool(*j.Enabled), Schedule: j.Schedule, Storage: j.Storage,
			Mode: cmp.Or(j.Mode, "snapshot"), Compress: j.Compress, All: bool(j.All), VMIDs: parseIDs(string(j.VMID)),
			Exclude: parseIDs(string(j.Exclude)), Node: j.Node, Retention: parseRetention(j.Prune), Comment: j.Comment, NextRun: int64(j.NextRun),
		})
	}
	slices.SortFunc(out, func(x, y backupJob) int { return cmp.Compare(x.ID, y.ID) })
	return out, nil
}

func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	jobs, err := s.listJobs(r, a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, jobs)
}

// Agendamento no formato de calendário do systemd/PVE: "daily", "sun 01:00",
// "mon..fri 02:30", "*-*-* 03:00", "*/6:00"...
var scheduleRe = regexp.MustCompile(`^[a-zA-Z0-9 .,:*/\-]{1,64}$`)

func jobForm(j backupJob, create bool) (url.Values, error) {
	if !scheduleRe.MatchString(j.Schedule) {
		return nil, fmt.Errorf("agendamento inválido")
	}
	if j.Storage == "" {
		return nil, fmt.Errorf("escolha o storage")
	}
	if !j.All && len(j.VMIDs) == 0 {
		return nil, fmt.Errorf("escolha os guests ou marque todos")
	}
	if !slices.Contains([]string{"snapshot", "suspend", "stop"}, j.Mode) {
		j.Mode = "snapshot"
	}
	f := url.Values{
		"schedule":      {j.Schedule},
		"storage":       {j.Storage},
		"mode":          {j.Mode},
		"compress":      {cmp.Or(j.Compress, "zstd")},
		"enabled":       {b01(j.Enabled)},
		"prune-backups": {j.Retention.String()},
	}
	var del []string
	if j.All {
		f.Set("all", "1")
		if len(j.Exclude) > 0 {
			f.Set("exclude", joinIDs(j.Exclude))
		} else if !create {
			del = append(del, "exclude")
		}
		if !create {
			del = append(del, "vmid")
		}
	} else {
		f.Set("vmid", joinIDs(j.VMIDs))
		if !create {
			f.Set("all", "0")
			del = append(del, "exclude")
		}
	}
	if j.Comment != "" {
		f.Set("comment", j.Comment)
	} else if !create {
		del = append(del, "comment")
	}
	if len(del) > 0 {
		f.Set("delete", strings.Join(del, ","))
	}
	return f, nil
}

func (s *Server) handleJobSave(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var j backupJob
	if err := readJSON(r, &j); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	id := r.PathValue("id")
	f, err := jobForm(j, id == "")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if id == "" {
		err = s.pve.Post(r.Context(), &a, "/cluster/backup", f, nil)
	} else {
		err = s.pve.Put(r.Context(), &a, "/cluster/backup/"+url.PathEscape(id), f, nil)
	}
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleJobDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if err := s.pve.Delete(r.Context(), &a, "/cluster/backup/"+url.PathEscape(r.PathValue("id")), nil, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleJobRun roda o job agora: um vzdump por nó com os guests que estão nele.
func (s *Server) handleJobRun(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	jobs, err := s.listJobs(r, a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	i := slices.IndexFunc(jobs, func(j backupJob) bool { return j.ID == r.PathValue("id") })
	if i < 0 {
		writeErr(w, http.StatusNotFound, "job não encontrado")
		return
	}
	j := jobs[i]
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	byNode := map[string][]int{}
	for _, g := range res {
		if g.Type == "node" && g.Status == "online" && j.All && (j.Node == "" || j.Node == g.Node) {
			byNode[g.Node] = byNode[g.Node]
		}
		if !g.IsGuest() || bool(g.Template) {
			continue
		}
		if !j.All && slices.Contains(j.VMIDs, g.VMID) {
			byNode[g.Node] = append(byNode[g.Node], g.VMID)
		}
	}
	type result struct {
		Node  string `json:"node"`
		UPID  string `json:"upid,omitempty"`
		Error string `json:"error,omitempty"`
	}
	out := []result{}
	nodes := make([]string, 0, len(byNode))
	for n := range byNode {
		nodes = append(nodes, n)
	}
	slices.Sort(nodes)
	for _, n := range nodes {
		f := url.Values{"storage": {j.Storage}, "mode": {j.Mode}, "compress": {cmp.Or(j.Compress, "zstd")}, "prune-backups": {j.Retention.String()}}
		if j.All {
			f.Set("all", "1")
			if len(j.Exclude) > 0 {
				f.Set("exclude", joinIDs(j.Exclude))
			}
		} else {
			f.Set("vmid", joinIDs(byNode[n]))
		}
		upid, err := s.pve.Vzdump(r.Context(), &a, n, f)
		res := result{Node: n, UPID: upid}
		if err != nil {
			res.Error = err.Error()
		}
		out = append(out, res)
	}
	writeJSON(w, map[string]any{"tasks": out})
}

type guestBackup struct {
	VMID    int    `json:"vmid"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Node    string `json:"node"`
	Last    int64  `json:"last"` // 0 = nunca
	Storage string `json:"storage"`
	Size    int64  `json:"size"`
	Count   int    `json:"count"`
	Covered bool   `json:"covered"` // algum job inclui
}

// handleBackupStatus varre o conteúdo "backup" dos storages e cruza com os guests.
func (s *Server) handleBackupStatus(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	res, err := s.resources(r.Context(), a)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	ctx := r.Context()
	type src struct{ node, storage string }
	var srcs []src
	seen := map[string]bool{}
	for _, st := range res {
		if st.Type != "storage" || st.Status != "available" || !hasContent(st.Content, "backup") {
			continue
		}
		key := st.Node + "/" + st.Storage
		if st.Shared {
			key = st.Storage
		}
		if !seen[key] {
			seen[key] = true
			srcs = append(srcs, src{st.Node, st.Storage})
		}
	}
	type vol struct {
		VMID  pve.Num `json:"vmid"`
		CTime int64   `json:"ctime"`
		Size  int64   `json:"size"`
	}
	var (
		mu   sync.Mutex
		wg   sync.WaitGroup
		last = map[int]*guestBackup{}
	)
	for _, sr := range srcs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var vols []vol
			path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(sr.node), url.PathEscape(sr.storage))
			if s.pve.Get(ctx, &a, path, url.Values{"content": {"backup"}}, &vols) != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, v := range vols {
				id := int(v.VMID)
				b := last[id]
				if b == nil {
					b = &guestBackup{VMID: id}
					last[id] = b
				}
				b.Count++
				if v.CTime > b.Last {
					b.Last, b.Storage, b.Size = v.CTime, sr.storage, v.Size
				}
			}
		}()
	}
	var notCovered []struct {
		VMID pve.Num `json:"vmid"`
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.pve.Get(ctx, &a, "/cluster/backup-info/not-backed-up", nil, &notCovered)
	}()
	wg.Wait()
	uncovered := map[int]bool{}
	for _, g := range notCovered {
		uncovered[int(g.VMID)] = true
	}
	out := []guestBackup{}
	for _, g := range res {
		if !g.IsGuest() || bool(g.Template) {
			continue
		}
		b := guestBackup{VMID: g.VMID}
		if x := last[g.VMID]; x != nil {
			b = *x
		}
		b.Name, b.Type, b.Node, b.Covered = g.Name, g.Type, g.Node, !uncovered[g.VMID]
		out = append(out, b)
	}
	slices.SortFunc(out, func(x, y guestBackup) int { return x.VMID - y.VMID })
	writeJSON(w, out)
}

// --- tarefas ---

type taskRow struct {
	UPID      string `json:"upid"`
	Node      string `json:"node"`
	Type      string `json:"type"`
	ID        string `json:"id"`
	User      string `json:"user"`
	Status    string `json:"status"` // "" rodando, "OK", ou a mensagem de erro
	StartTime int64  `json:"starttime"`
	EndTime   int64  `json:"endtime"`
}

func (s *Server) handleTaskList(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var raw []taskRow
	if err := s.pve.Get(r.Context(), &a, "/cluster/tasks", nil, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	if raw == nil {
		raw = []taskRow{}
	}
	slices.SortFunc(raw, func(x, y taskRow) int { return cmp.Compare(y.StartTime, x.StartTime) })
	writeJSON(w, raw)
}

func (s *Server) handleTaskStop(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	upid := r.PathValue("upid")
	node := pve.NodeOfUPID(upid)
	if node == "" {
		writeErr(w, http.StatusBadRequest, "upid inválido")
		return
	}
	if err := s.pve.Delete(r.Context(), &a, "/nodes/"+url.PathEscape(node)+"/tasks/"+url.PathEscape(upid), nil, nil); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

package server

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Agendamentos da Mia: ligar/desligar em horários, snapshots automáticos
// com retenção e o teste de restauração de backup. Rodam sem ninguém logado,
// com o token de API que o instalador cria (MIA_PVE_TOKEN).

type jobResult struct {
	At       int64  `json:"at"`
	OK       bool   `json:"ok"`
	Message  string `json:"message"`
	Duration int    `json:"duration"` // segundos
}

type job struct {
	ID         string      `json:"id"`
	Kind       string      `json:"kind"` // power | snapshot | restoretest
	Name       string      `json:"name"`
	Enabled    bool        `json:"enabled"`
	Time       string      `json:"time"`       // "HH:MM" (power, restoretest)
	Days       []int       `json:"days"`       // 0=domingo..6; vazio = todo dia
	EveryHours int         `json:"everyHours"` // snapshot: intervalo
	Targets    []string    `json:"targets"`    // "lxc/101", "qemu/102"
	Action     string      `json:"action"`     // power: start | shutdown | reboot
	Keep       int         `json:"keep"`       // snapshot: quantos automáticos guardar
	Storage    string      `json:"storage"`    // restoretest: onde restaurar
	Cursor     int         `json:"cursor"`     // restoretest: próximo da fila
	LastRun    int64       `json:"lastRun"`
	History    []jobResult `json:"history"`
}

// restoreSettle é quanto o guest restaurado precisa ficar ligado pra passar.
var restoreSettle = 20 * time.Second

var (
	timeRe   = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	targetRe = regexp.MustCompile(`^(lxc|qemu)/\d+$`)
)

func (j *job) validate() error {
	switch j.Kind {
	case "power":
		if !slices.Contains([]string{"start", "shutdown", "reboot"}, j.Action) {
			return fmt.Errorf("ação inválida")
		}
		if !timeRe.MatchString(j.Time) {
			return fmt.Errorf("horário inválido (HH:MM)")
		}
	case "snapshot":
		if j.EveryHours < 1 || j.EveryHours > 24*31 {
			return fmt.Errorf("intervalo inválido")
		}
		if j.Keep < 1 || j.Keep > 100 {
			return fmt.Errorf("quantidade a guardar inválida")
		}
	case "restoretest":
		if !timeRe.MatchString(j.Time) {
			return fmt.Errorf("horário inválido (HH:MM)")
		}
		if j.Storage == "" {
			return fmt.Errorf("escolha onde restaurar")
		}
	default:
		return fmt.Errorf("tipo de agendamento inválido")
	}
	if len(j.Targets) == 0 {
		return fmt.Errorf("escolha pelo menos um guest")
	}
	for _, t := range j.Targets {
		if !targetRe.MatchString(t) {
			return fmt.Errorf("guest inválido: %s", t)
		}
	}
	for _, d := range j.Days {
		if d < 0 || d > 6 {
			return fmt.Errorf("dia inválido")
		}
	}
	j.Name = strings.TrimSpace(j.Name)
	if len(j.Name) > 80 {
		return fmt.Errorf("nome grande demais")
	}
	return nil
}

// due diz se o job deve rodar no minuto now.
func (j *job) due(now time.Time) bool {
	if !j.Enabled {
		return false
	}
	if j.Kind == "snapshot" {
		return now.Unix()-j.LastRun >= int64(j.EveryHours)*3600-30
	}
	if now.Format("15:04") != j.Time {
		return false
	}
	if len(j.Days) > 0 && !slices.Contains(j.Days, int(now.Weekday())) {
		return false
	}
	return now.Unix()-j.LastRun > 90 // não repete no mesmo minuto
}

type scheduler struct {
	s       *Server
	token   string
	mu      sync.Mutex
	running map[string]bool
}

// jobAuth é a credencial dos agendamentos: o token; no demo, um login comum.
func (s *Server) jobAuth(ctx context.Context) (pve.Auth, error) {
	if s.cfg.Token != "" {
		user, _, _ := strings.Cut(s.cfg.Token, "!")
		return pve.Auth{User: user, Token: s.cfg.Token}, nil
	}
	if s.cfg.Demo {
		res, err := s.pve.Login(ctx, "root@pam", "demo")
		if err != nil {
			return pve.Auth{}, err
		}
		return res.Auth, nil
	}
	return pve.Auth{}, fmt.Errorf("sem token da Mia: rode o instalador de novo pra criar")
}

func (sc *scheduler) loop(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			for _, j := range sc.s.state.jobsSnapshot() {
				if j.due(now) {
					go sc.run(context.Background(), j.ID)
				}
			}
		}
	}
}

// run executa um job (agendado ou "rodar agora") e grava o resultado.
func (sc *scheduler) run(ctx context.Context, id string) {
	sc.mu.Lock()
	if sc.running[id] {
		sc.mu.Unlock()
		return
	}
	sc.running[id] = true
	sc.mu.Unlock()
	defer func() {
		sc.mu.Lock()
		delete(sc.running, id)
		sc.mu.Unlock()
	}()

	j, ok := sc.s.state.job(id)
	if !ok {
		return
	}
	start := time.Now()
	sc.s.state.updateJob(id, func(x *job) { x.LastRun = start.Unix() })
	ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	msg, err := sc.exec(ctx, j)
	res := jobResult{At: start.Unix(), OK: err == nil, Message: msg, Duration: int(time.Since(start).Seconds())}
	if err != nil {
		res.Message = err.Error()
		slog.Warn("agendamento falhou", "job", j.Name, "err", err)
	}
	sc.s.state.updateJob(id, func(x *job) {
		x.History = append([]jobResult{res}, x.History...)
		if len(x.History) > 20 {
			x.History = x.History[:20]
		}
		if j.Kind == "restoretest" {
			x.Cursor = j.Cursor + 1
		}
	})
}

func (sc *scheduler) exec(ctx context.Context, j job) (string, error) {
	a, err := sc.s.jobAuth(ctx)
	if err != nil {
		return "", err
	}
	res, err := sc.s.pve.Resources(ctx, &a)
	if err != nil {
		return "", err
	}
	find := func(t string) (pve.Resource, bool) {
		i := slices.IndexFunc(res, func(r pve.Resource) bool { return r.ID == t })
		if i < 0 {
			return pve.Resource{}, false
		}
		return res[i], true
	}
	switch j.Kind {
	case "power":
		var done, skipped []string
		for _, t := range j.Targets {
			g, ok := find(t)
			if !ok {
				skipped = append(skipped, t+" (não existe)")
				continue
			}
			if (j.Action == "start" && g.Status == "running") || (j.Action != "start" && g.Status != "running") {
				skipped = append(skipped, g.Name)
				continue
			}
			if _, err := sc.s.pve.GuestAction(ctx, &a, g.Node, g.Type, g.VMID, j.Action); err != nil {
				return "", fmt.Errorf("%s: %w", g.Name, err)
			}
			done = append(done, g.Name)
		}
		msg := fmt.Sprintf("%s: %s", j.Action, strings.Join(done, ", "))
		if len(skipped) > 0 {
			msg += fmt.Sprintf(" (já estavam assim: %s)", strings.Join(skipped, ", "))
		}
		return msg, nil

	case "snapshot":
		var out []string
		for _, t := range j.Targets {
			g, ok := find(t)
			if !ok {
				continue
			}
			if err := sc.autoSnapshot(ctx, a, g, j.Keep); err != nil {
				return strings.Join(out, "; "), fmt.Errorf("%s: %w", g.Name, err)
			}
			out = append(out, g.Name)
		}
		return "snapshot de " + strings.Join(out, ", "), nil

	case "restoretest":
		return sc.restoreTest(ctx, a, j, find)
	}
	return "", fmt.Errorf("tipo desconhecido")
}

// waitTask espera uma task do PVE terminar e devolve erro se não deu OK.
func (s *Server) waitTask(ctx context.Context, a pve.Auth, upid string) error {
	node := pve.NodeOfUPID(upid)
	for {
		st, err := s.pve.TaskStatus(ctx, &a, node, upid)
		if err != nil {
			return err
		}
		if st.Status == "stopped" {
			if st.ExitStatus != "OK" && !strings.HasPrefix(st.ExitStatus, "WARNINGS") {
				return fmt.Errorf("task terminou com: %s", st.ExitStatus)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

type snapItem struct {
	Name     string  `json:"name"`
	SnapTime pve.Int `json:"snaptime"`
}

func (sc *scheduler) autoSnapshot(ctx context.Context, a pve.Auth, g pve.Resource, keep int) error {
	name := "auto_" + time.Now().Format("20060102_150405")
	var upid string
	err := sc.s.pve.Post(ctx, &a, snapPath(g), url.Values{"snapname": {name}, "description": {"Mia: snapshot automático"}}, &upid)
	if err != nil {
		return err
	}
	if err := sc.s.waitTask(ctx, a, upid); err != nil {
		return err
	}
	var list []snapItem
	if err := sc.s.pve.Get(ctx, &a, snapPath(g), nil, &list); err != nil {
		return err
	}
	autos := slices.DeleteFunc(list, func(x snapItem) bool { return !strings.HasPrefix(x.Name, "auto_") })
	slices.SortFunc(autos, func(x, y snapItem) int { return cmp.Compare(y.SnapTime, x.SnapTime) })
	for _, old := range autos[min(keep, len(autos)):] {
		var up string
		if err := sc.s.pve.Delete(ctx, &a, snapPath(g)+"/"+old.Name, nil, &up); err != nil {
			return err
		}
		if err := sc.s.waitTask(ctx, a, up); err != nil {
			return err
		}
	}
	return nil
}

// restoreTest restaura o último backup de um guest da fila num ID novo, sem
// rede (pra não bater IP com o original), liga, confere e apaga.
func (sc *scheduler) restoreTest(ctx context.Context, a pve.Auth, j job, find func(string) (pve.Resource, bool)) (string, error) {
	t := j.Targets[j.Cursor%len(j.Targets)]
	g, ok := find(t)
	if !ok {
		return "", fmt.Errorf("%s não existe mais", t)
	}
	// Último backup em qualquer storage.
	var best struct {
		volid string
		ctime int64
	}
	res, _ := sc.s.pve.Resources(ctx, &a)
	seen := map[string]bool{}
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
		var vols []struct {
			Volid string  `json:"volid"`
			CTime pve.Int `json:"ctime"`
		}
		path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(st.Node), url.PathEscape(st.Storage))
		if sc.s.pve.Get(ctx, &a, path, url.Values{"content": {"backup"}, "vmid": {strconv.Itoa(g.VMID)}}, &vols) == nil {
			for _, v := range vols {
				if int64(v.CTime) > best.ctime {
					best.volid, best.ctime = v.Volid, int64(v.CTime)
				}
			}
		}
	}
	if best.volid == "" {
		return "", fmt.Errorf("%s não tem backup", g.Name)
	}
	id, err := sc.s.pve.NextID(ctx, &a)
	if err != nil {
		return "", err
	}
	f := url.Values{"vmid": {strconv.Itoa(id)}, "storage": {j.Storage}, "unique": {"1"}}
	if g.Type == "lxc" {
		f.Set("ostemplate", best.volid)
		f.Set("restore", "1")
	} else {
		f.Set("archive", best.volid)
	}
	var upid string
	if err := sc.s.pve.Post(ctx, &a, "/nodes/"+url.PathEscape(g.Node)+"/"+g.Type, f, &upid); err != nil {
		return "", fmt.Errorf("restaurar: %w", err)
	}
	tmp := pve.Resource{Node: g.Node, Type: g.Type, VMID: id}
	cleanup := func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		var up string
		sc.s.pve.Post(c, &a, pve.GuestPath(g.Node, g.Type, id)+"/status/stop", url.Values{}, &up)
		if up != "" {
			sc.s.waitTask(c, a, up)
		}
		var del string
		if sc.s.pve.Delete(c, &a, pve.GuestPath(g.Node, g.Type, id), url.Values{"purge": {"1"}, "destroy-unreferenced-disks": {"1"}}, &del) == nil && del != "" {
			sc.s.waitTask(c, a, del)
		}
	}
	if err := sc.s.waitTask(ctx, a, upid); err != nil {
		cleanup()
		return "", fmt.Errorf("restaurar: %w", err)
	}
	defer cleanup()

	// Sem rede, sem ligar com o nó, e com nome que diz o que é.
	raw, _ := sc.s.rawConfig(ctx, a, tmp)
	del := []string{"onboot"}
	for k := range raw {
		if netKeyRe.MatchString(k) || strings.HasPrefix(k, "usb") || strings.HasPrefix(k, "hostpci") {
			del = append(del, k)
		}
	}
	f = url.Values{"delete": {strings.Join(del, ",")}}
	if g.Type == "lxc" {
		f.Set("hostname", "mia-teste-"+strconv.Itoa(g.VMID))
	} else {
		f.Set("name", "mia-teste-"+strconv.Itoa(g.VMID))
	}
	if err := sc.s.pve.Put(ctx, &a, cfgPath(tmp), f, nil); err != nil {
		return "", fmt.Errorf("preparar: %w", err)
	}
	var st string
	if err := sc.s.pve.Post(ctx, &a, pve.GuestPath(g.Node, g.Type, id)+"/status/start", url.Values{}, &st); err != nil {
		return "", fmt.Errorf("ligar: %w", err)
	}
	if err := sc.s.waitTask(ctx, a, st); err != nil {
		return "", fmt.Errorf("ligar: %w", err)
	}
	// Fica ligado uns segundos sem cair.
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(restoreSettle):
	}
	var status struct {
		Status string `json:"status"`
	}
	if err := sc.s.pve.Get(ctx, &a, pve.GuestPath(g.Node, g.Type, id)+"/status/current", nil, &status); err != nil {
		return "", err
	}
	if status.Status != "running" {
		return "", fmt.Errorf("o backup de %s restaurou mas não ficou ligado (%s)", g.Name, status.Status)
	}
	return fmt.Sprintf("backup de %s (%s) restaurou e ligou", g.Name, time.Unix(best.ctime, 0).Format("02/01 15:04")), nil
}

// --- API ---

func newJobID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) handleJobsList(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	writeJSON(w, map[string]any{
		"jobs":     s.state.jobsSnapshot(),
		"token":    s.cfg.Token != "" || s.cfg.Demo,
		"timeZone": time.Now().Format("MST -07:00"),
	})
}

func (s *Server) handleJobsSave(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	var j job
	if err := readJSON(r, &j); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	if err := j.validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if j.ID == "" {
		j.ID = newJobID()
		j.History = []jobResult{}
		j.LastRun = time.Now().Unix() // snapshot: o primeiro sai depois do intervalo
		if err := s.state.addJob(j); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if !s.state.updateJob(j.ID, func(x *job) {
		hist, last, cur := x.History, x.LastRun, x.Cursor
		*x = j
		x.History, x.LastRun, x.Cursor = hist, last, cur
	}) {
		writeErr(w, http.StatusNotFound, "agendamento não existe")
		return
	}
	writeJSON(w, map[string]string{"id": j.ID})
}

func (s *Server) handleJobsDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	s.state.deleteJob(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleJobsRun(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	if _, ok := s.state.job(r.PathValue("id")); !ok {
		writeErr(w, http.StatusNotFound, "agendamento não existe")
		return
	}
	go s.sched.run(context.Background(), r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

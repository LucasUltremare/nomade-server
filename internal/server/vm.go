package server

import (
	"cmp"
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

// VMs (criar a partir de ISO, trocar CD), snapshots, clonar/template/apagar
// e as séries de métricas de cada guest.

// --- snapshots ---

type snapshotView struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Time        int64  `json:"time"`
	Parent      string `json:"parent"`
	RAM         bool   `json:"ram"`
	Current     bool   `json:"current"`
}

func snapPath(g pve.Resource) string { return pve.GuestPath(g.Node, g.Type, g.VMID) + "/snapshot" }

func (s *Server) handleSnapshots(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var raw []struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		SnapTime    pve.Int  `json:"snaptime"`
		Parent      string   `json:"parent"`
		VMState     pve.Bool `json:"vmstate"`
	}
	if err := s.pve.Get(r.Context(), &a, snapPath(g), nil, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	out := []snapshotView{}
	for _, x := range raw {
		out = append(out, snapshotView{Name: x.Name, Description: strings.TrimSpace(x.Description), Time: int64(x.SnapTime),
			Parent: x.Parent, RAM: bool(x.VMState), Current: x.Name == "current"})
	}
	// "current" (o estado atual) vai pro fim; o resto em ordem de criação.
	slices.SortFunc(out, func(x, y snapshotView) int {
		if x.Current != y.Current {
			if x.Current {
				return 1
			}
			return -1
		}
		return cmp.Compare(x.Time, y.Time)
	})
	writeJSON(w, out)
}

var snapNameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{1,39}$`)

func (s *Server) handleSnapshotCreate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		RAM         bool   `json:"ram"`
	}
	if err := readJSON(r, &body); err != nil || !snapNameRe.MatchString(body.Name) || body.Name == "current" {
		writeErr(w, http.StatusBadRequest, "nome inválido: comece com letra; letras, números, - e _ (2 a 40)")
		return
	}
	f := url.Values{"snapname": {body.Name}}
	if body.Description != "" {
		f.Set("description", body.Description)
	}
	if g.Type == "qemu" && body.RAM && g.Status == "running" {
		f.Set("vmstate", "1")
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, snapPath(g), f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleSnapshotRollback(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	snap := r.PathValue("snap")
	if !snapNameRe.MatchString(snap) {
		writeErr(w, http.StatusBadRequest, "snapshot inválido")
		return
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, snapPath(g)+"/"+snap+"/rollback", url.Values{}, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleSnapshotDelete(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	snap := r.PathValue("snap")
	if !snapNameRe.MatchString(snap) {
		writeErr(w, http.StatusBadRequest, "snapshot inválido")
		return
	}
	var upid string
	if err := s.pve.Delete(r.Context(), &a, snapPath(g)+"/"+snap, nil, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// --- métricas do guest ---

var guestRanges = map[string]string{"1h": "hour", "24h": "day", "7d": "week", "30d": "month"}

func (s *Server) handleGuestRRD(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	tf, ok := guestRanges[r.URL.Query().Get("range")]
	if !ok {
		tf = "day"
	}
	pts, err := s.pve.GuestRRD(r.Context(), &a, g.Node, g.Type, g.VMID, tf)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	out := struct {
		T         []int64   `json:"t"`
		CPU       []float64 `json:"cpu"` // %
		Mem       []float64 `json:"mem"` // bytes
		MaxMem    float64   `json:"maxmem"`
		NetIn     []float64 `json:"netin"` // bytes/s
		NetOut    []float64 `json:"netout"`
		DiskRead  []float64 `json:"diskread"`
		DiskWrite []float64 `json:"diskwrite"`
	}{T: []int64{}, CPU: []float64{}, Mem: []float64{}, NetIn: []float64{}, NetOut: []float64{}, DiskRead: []float64{}, DiskWrite: []float64{}}
	for _, p := range pts {
		cpu, ok := p.F("cpu")
		if !ok {
			continue // guest desligado nesse trecho
		}
		f := func(k string) float64 { v, _ := p.F(k); return v }
		out.T = append(out.T, p.Time())
		out.CPU = append(out.CPU, round1(cpu*100))
		out.Mem = append(out.Mem, f("mem"))
		out.MaxMem = max(out.MaxMem, f("maxmem"))
		out.NetIn = append(out.NetIn, f("netin"))
		out.NetOut = append(out.NetOut, f("netout"))
		out.DiskRead = append(out.DiskRead, f("diskread"))
		out.DiskWrite = append(out.DiskWrite, f("diskwrite"))
	}
	writeJSON(w, out)
}

// --- criar VM ---

func (s *Server) handleVMOptions(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node := r.PathValue("node")
	ctx := r.Context()
	out := struct {
		NextID  int          `json:"nextid"`
		ISOs    []tmplView   `json:"isos"`
		Disks   []storageOpt `json:"disks"`
		Bridges []bridgeView `json:"bridges"`
	}{ISOs: []tmplView{}, Disks: []storageOpt{}, Bridges: []bridgeView{}}
	stores, err := s.pve.NodeStorage(ctx, &a, node, "")
	if err != nil {
		writePVEErr(w, err)
		return
	}
	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)
	for _, st := range stores {
		if !st.Active || !st.Enabled {
			continue
		}
		if hasContent(st.Content, "images") {
			out.Disks = append(out.Disks, storageOpt{Storage: st.Storage, Type: st.Type, Avail: st.Avail, Total: st.Total})
		}
		if hasContent(st.Content, "iso") {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var content []struct {
					Volid string  `json:"volid"`
					Size  pve.Int `json:"size"`
				}
				path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(node), url.PathEscape(st.Storage))
				if s.pve.Get(ctx, &a, path, url.Values{"content": {"iso"}}, &content) == nil {
					mu.Lock()
					for _, c := range content {
						out.ISOs = append(out.ISOs, tmplView{Volid: c.Volid, Name: c.Volid[strings.LastIndex(c.Volid, "/")+1:], Size: c.Size})
					}
					mu.Unlock()
				}
			}()
		}
	}
	wg.Add(2)
	go func() { defer wg.Done(); out.NextID, _ = s.pve.NextID(ctx, &a) }()
	go func() {
		defer wg.Done()
		var ifaces []bridgeView
		if s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(node)+"/network", url.Values{"type": {"any_bridge"}}, &ifaces) == nil && ifaces != nil {
			out.Bridges = ifaces
		}
	}()
	wg.Wait()
	slices.SortFunc(out.ISOs, func(x, y tmplView) int { return strings.Compare(x.Name, y.Name) })
	slices.SortFunc(out.Bridges, func(x, y bridgeView) int { return strings.Compare(x.Iface, y.Iface) })
	writeJSON(w, out)
}

type vmRequest struct {
	VMID    int    `json:"vmid"`
	Name    string `json:"name"`
	OS      string `json:"os"` // linux | win11 | win10 | other
	ISO     string `json:"iso"`
	Cores   int    `json:"cores"`
	Memory  int    `json:"memory"` // MB
	Disk    int    `json:"disk"`   // GB
	Storage string `json:"storage"`
	Bridge  string `json:"bridge"`
	VLAN    int    `json:"vlan"`
	Start   bool   `json:"start"`
	OnBoot  bool   `json:"onboot"`
}

// form segue os padrões que o assistente do PVE 9 usa pra cada tipo de SO.
func (q vmRequest) form() (url.Values, error) {
	if !hostnameRe.MatchString(q.Name) {
		return nil, fmt.Errorf("nome inválido (letras, números e hífen)")
	}
	if q.Storage == "" || q.Bridge == "" || q.Disk < 1 {
		return nil, fmt.Errorf("storage, bridge e disco são obrigatórios")
	}
	f := url.Values{
		"vmid":        {strconv.Itoa(q.VMID)},
		"name":        {q.Name},
		"cores":       {strconv.Itoa(max(1, q.Cores))},
		"sockets":     {"1"},
		"cpu":         {"host"},
		"memory":      {strconv.Itoa(max(256, q.Memory))},
		"scsihw":      {"virtio-scsi-single"},
		"scsi0":       {fmt.Sprintf("%s:%d,iothread=1,discard=on,ssd=1", q.Storage, q.Disk)},
		"agent":       {"1"},
		"onboot":      {b01(q.OnBoot)},
		"start":       {b01(q.Start)},
		"description": {"Criada pelo Mia"},
	}
	net0 := "virtio,bridge=" + q.Bridge + ",firewall=1"
	if q.VLAN > 0 {
		net0 += ",tag=" + strconv.Itoa(q.VLAN)
	}
	f.Set("net0", net0)
	cd := "none,media=cdrom"
	if q.ISO != "" {
		cd = q.ISO + ",media=cdrom"
	}
	f.Set("ide2", cd)
	f.Set("boot", "order=scsi0;ide2;net0")
	switch q.OS {
	case "win11", "win10":
		// UEFI + TPM e disco SATA no começo (o instalador não tem driver VirtIO).
		f.Set("ostype", q.OS)
		f.Set("machine", "q35")
		f.Set("bios", "ovmf")
		f.Set("efidisk0", q.Storage+":1,efitype=4m,pre-enrolled-keys=1")
		if q.OS == "win11" {
			f.Set("tpmstate0", q.Storage+":1,version=v2.0")
		}
		f.Del("scsi0")
		f.Set("sata0", fmt.Sprintf("%s:%d,discard=on,ssd=1", q.Storage, q.Disk))
		f.Set("boot", "order=sata0;ide2;net0")
		f.Set("net0", strings.Replace(net0, "virtio,", "e1000e,", 1))
		f.Set("cpu", "x86-64-v2-AES")
	case "other":
		f.Set("ostype", "other")
	default:
		f.Set("ostype", "l26")
	}
	return f, nil
}

func (s *Server) handleVMCreate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body vmRequest
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
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
	form, err := body.form()
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/qemu", form, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]any{"upid": upid, "vmid": body.VMID})
}

// handleCDROM troca (ou ejeta) a ISO do drive de CD da VM.
func (s *Server) handleCDROM(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	if g.Type != "qemu" {
		writeErr(w, http.StatusBadRequest, "só VMs têm CD")
		return
	}
	var body struct {
		ISO string `json:"iso"`
	}
	if err := readJSON(r, &body); err != nil || strings.ContainsAny(body.ISO, ",=") {
		writeErr(w, http.StatusBadRequest, "ISO inválida")
		return
	}
	value := "none,media=cdrom"
	if body.ISO != "" {
		value = body.ISO + ",media=cdrom"
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{"ide2": {value}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// --- clonar, template, apagar ---

func (s *Server) handleClone(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		NewID   int    `json:"newid"`
		Name    string `json:"name"`
		Full    bool   `json:"full"`
		Target  string `json:"target"`
		Storage string `json:"storage"`
	}
	if err := readJSON(r, &body); err != nil || !hostnameRe.MatchString(body.Name) {
		writeErr(w, http.StatusBadRequest, "nome inválido (letras, números e hífen)")
		return
	}
	if body.NewID == 0 {
		id, err := s.pve.NextID(r.Context(), &a)
		if err != nil {
			writePVEErr(w, err)
			return
		}
		body.NewID = id
	}
	f := url.Values{"newid": {strconv.Itoa(body.NewID)}}
	if g.Type == "lxc" {
		f.Set("hostname", body.Name)
	} else {
		f.Set("name", body.Name)
	}
	// Clone ligado (linked) só sai de template; de guest normal é sempre completo.
	if body.Full || !bool(g.Template) {
		f.Set("full", "1")
		if body.Storage != "" {
			f.Set("storage", body.Storage)
		}
	}
	if body.Target != "" && body.Target != g.Node {
		f.Set("target", body.Target)
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/clone", f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]any{"upid": upid, "vmid": body.NewID})
}

func (s *Server) handleTemplate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	if g.Status == "running" {
		writeErr(w, http.StatusConflict, "desligue o guest antes de virar template")
		return
	}
	var out any
	if err := s.pve.Post(r.Context(), &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/template", url.Values{}, &out); err != nil {
		writePVEErr(w, err)
		return
	}
	upid, _ := out.(string)
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleDestroy(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Confirm string `json:"confirm"`
	}
	readJSON(r, &body)
	// Confirmação explícita: o nome (ou o ID, se não tiver nome).
	if body.Confirm != g.Name && body.Confirm != strconv.Itoa(g.VMID) {
		writeErr(w, http.StatusBadRequest, "digite o nome do guest pra confirmar")
		return
	}
	if g.Status == "running" {
		writeErr(w, http.StatusConflict, "desligue o guest antes de apagar")
		return
	}
	q := url.Values{"purge": {"1"}, "destroy-unreferenced-disks": {"1"}}
	var upid string
	if err := s.pve.Delete(r.Context(), &a, pve.GuestPath(g.Node, g.Type, g.VMID), q, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Hardware de um guest já criado: CPU/RAM, discos (rootfs e pontos de
// montagem no LXC; scsi/virtio/sata/ide nas VMs) e migração entre nós.

type diskView struct {
	Key        string            `json:"key"`    // rootfs, mp0, scsi0, unused0...
	Volume     string            `json:"volume"` // tank:subvol-101-disk-0 ou /caminho (bind)
	Storage    string            `json:"storage"`
	Size       int64             `json:"size"`
	Mountpoint string            `json:"mountpoint,omitempty"`
	Backup     bool              `json:"backup"`
	Bind       bool              `json:"bind"`
	Unused     bool              `json:"unused"`
	Opts       map[string]string `json:"opts"`
}

type guestConfig struct {
	Node     string            `json:"node"`
	Kind     string            `json:"kind"`
	VMID     int               `json:"vmid"`
	Status   string            `json:"status"`
	Cores    int               `json:"cores"`
	Memory   int               `json:"memory"` // MB
	Swap     int               `json:"swap"`   // MB (só LXC)
	Disks    []diskView        `json:"disks"`
	Storages []storageOpt      `json:"storages"` // onde dá pra criar/mover discos
	Pending  []string          `json:"pending"`  // chaves que só valem depois de reiniciar
	HasCD    bool              `json:"hasCd"`    // VM com drive de CD (ide2)
	CDROM    string            `json:"cdrom"`    // ISO no CD ("" = vazio)
	Nets     []netView         `json:"nets"`
	Devices  []deviceView      `json:"devices"`
	Options  map[string]string `json:"options"`
}

var (
	lxcDiskRe  = regexp.MustCompile(`^(rootfs|mp\d+|unused\d+)$`)
	qemuDiskRe = regexp.MustCompile(`^((scsi|virtio|sata|ide)\d+|unused\d+)$`)
)

// parseSize lê "8G", "512M", "1T" (sem unidade = bytes... no PVE é GiB pra disco).
func parseSize(s string) int64 {
	if s == "" {
		return 0
	}
	mult := map[byte]int64{'K': 1 << 10, 'M': 1 << 20, 'G': 1 << 30, 'T': 1 << 40}
	last := s[len(s)-1]
	if m, ok := mult[last]; ok {
		f, _ := strconv.ParseFloat(s[:len(s)-1], 64)
		return int64(f * float64(m))
	}
	f, _ := strconv.ParseFloat(s, 64)
	return int64(f) << 30
}

// parseDisk separa "vol,opt=x,opt2=y".
func parseDisk(key, raw string) (diskView, bool) {
	parts := strings.Split(raw, ",")
	d := diskView{Key: key, Volume: parts[0], Backup: true, Unused: strings.HasPrefix(key, "unused")}
	opts := map[string]string{}
	for _, p := range parts[1:] {
		if k, v, ok := strings.Cut(p, "="); ok {
			opts[k] = v
		}
	}
	if opts["media"] == "cdrom" || d.Volume == "none" {
		return d, false
	}
	if i := strings.Index(d.Volume, ":"); i > 0 && !strings.HasPrefix(d.Volume, "/") {
		d.Storage = d.Volume[:i]
	} else {
		d.Bind = true
	}
	d.Size = parseSize(opts["size"])
	d.Mountpoint = opts["mp"]
	if key == "rootfs" {
		d.Mountpoint = "/"
	}
	if opts["backup"] == "0" {
		d.Backup = false
	}
	return d, true
}

func (s *Server) findGuest(ctx context.Context, a pve.Auth, kind string, vmid int) (pve.Resource, error) {
	res, err := s.resources(ctx, a)
	if err != nil {
		return pve.Resource{}, err
	}
	i := slices.IndexFunc(res, func(g pve.Resource) bool { return g.Type == kind && g.VMID == vmid })
	if i < 0 {
		return pve.Resource{}, &pve.Error{Status: http.StatusNotFound, Msg: "guest não encontrado"}
	}
	return res[i], nil
}

// guestFromPath valida {kind}/{vmid} da URL e acha o nó do guest.
func (s *Server) guestFromPath(w http.ResponseWriter, r *http.Request, a pve.Auth) (pve.Resource, bool) {
	kind := r.PathValue("kind")
	vmid, err := strconv.Atoi(r.PathValue("vmid"))
	if err != nil || (kind != "qemu" && kind != "lxc") {
		writeErr(w, http.StatusBadRequest, "guest inválido")
		return pve.Resource{}, false
	}
	g, err := s.findGuest(r.Context(), a, kind, vmid)
	if err != nil {
		writePVEErr(w, err)
		return pve.Resource{}, false
	}
	return g, true
}

func cfgPath(g pve.Resource) string {
	return pve.GuestPath(g.Node, g.Type, g.VMID) + "/config"
}

func (s *Server) handleGuestConfig(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var raw map[string]any
	if err := s.pve.Get(r.Context(), &a, cfgPath(g), nil, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	str := func(k string) string {
		switch v := raw[k].(type) {
		case string:
			return v
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
		return ""
	}
	num := func(k string, def int) int {
		if n, err := strconv.Atoi(str(k)); err == nil {
			return n
		}
		return def
	}
	cfg := guestConfig{Node: g.Node, Kind: g.Type, VMID: g.VMID, Status: g.Status, Disks: []diskView{}, Storages: []storageOpt{}, Pending: []string{}}
	cfg.Cores = num("cores", int(g.MaxCPU))
	if g.Type == "qemu" {
		cfg.Cores = num("cores", 1) * num("sockets", 1)
	}
	cfg.Memory = num("memory", int(g.MaxMem>>20))
	if cd := str("ide2"); g.Type == "qemu" && strings.Contains(cd, "media=cdrom") {
		cfg.HasCD = true
		if vol, _, _ := strings.Cut(cd, ","); vol != "none" && vol != "cdrom" {
			cfg.CDROM = vol
		}
	}
	cfg.Swap = num("swap", 0)

	re := lxcDiskRe
	content := "rootdir"
	if g.Type == "qemu" {
		re, content = qemuDiskRe, "images"
	}
	for k := range raw {
		if re.MatchString(k) {
			if d, ok := parseDisk(k, str(k)); ok {
				cfg.Disks = append(cfg.Disks, d)
			}
		}
	}
	order := func(k string) int {
		switch {
		case k == "rootfs":
			return 0
		case strings.HasPrefix(k, "unused"):
			return 2
		}
		return 1
	}
	slices.SortFunc(cfg.Disks, func(x, y diskView) int {
		if o := order(x.Key) - order(y.Key); o != 0 {
			return o
		}
		return strings.Compare(x.Key, y.Key)
	})

	// Pendências (mudança que espera reiniciar).
	var pending []struct {
		Key     string `json:"key"`
		Pending any    `json:"pending"`
		Delete  any    `json:"delete"`
	}
	if s.pve.Get(r.Context(), &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/pending", nil, &pending) == nil {
		for _, p := range pending {
			if p.Pending != nil || p.Delete != nil {
				cfg.Pending = append(cfg.Pending, p.Key)
			}
		}
	}

	enrichConfig(&cfg, g.Type, raw)
	if stores, err := s.pve.NodeStorage(r.Context(), &a, g.Node, ""); err == nil {
		for _, st := range stores {
			if bool(st.Active) && bool(st.Enabled) && hasContent(st.Content, content) {
				cfg.Storages = append(cfg.Storages, storageOpt{Storage: st.Storage, Type: st.Type, Avail: st.Avail, Total: st.Total})
			}
		}
	}
	writeJSON(w, cfg)
}

// putConfig manda mudanças pro config e devolve o UPID quando o PVE cria task.
func (s *Server) putConfig(ctx context.Context, a pve.Auth, g pve.Resource, f url.Values) (string, error) {
	var out any
	if err := s.pve.Put(ctx, &a, cfgPath(g), f, &out); err != nil {
		return "", err
	}
	upid, _ := out.(string)
	s.cache.invalidate(a.User)
	return upid, nil
}

func (s *Server) handleGuestResources(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Cores  int `json:"cores"`
		Memory int `json:"memory"`
		Swap   int `json:"swap"`
	}
	if err := readJSON(r, &body); err != nil || body.Cores < 1 || body.Cores > 512 || body.Memory < 16 {
		writeErr(w, http.StatusBadRequest, "CPU ou memória inválidos")
		return
	}
	f := url.Values{"cores": {strconv.Itoa(body.Cores)}, "memory": {strconv.Itoa(body.Memory)}}
	if g.Type == "lxc" {
		f.Set("swap", strconv.Itoa(max(0, body.Swap)))
	} else {
		f.Set("sockets", "1")
	}
	upid, err := s.putConfig(r.Context(), a, g, f)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

var diskKeyRe = regexp.MustCompile(`^(rootfs|mp\d+|unused\d+|(scsi|virtio|sata|ide)\d+)$`)

func (s *Server) handleDiskResize(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Disk string `json:"disk"`
		Add  int    `json:"add"` // GB a mais (o PVE não diminui disco)
	}
	if err := readJSON(r, &body); err != nil || !diskKeyRe.MatchString(body.Disk) || body.Add < 1 || body.Add > 65536 {
		writeErr(w, http.StatusBadRequest, "disco ou tamanho inválido")
		return
	}
	var out any
	path := pve.GuestPath(g.Node, g.Type, g.VMID) + "/resize"
	err := s.pve.Put(r.Context(), &a, path, url.Values{"disk": {body.Disk}, "size": {fmt.Sprintf("+%dG", body.Add)}}, &out)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	upid, _ := out.(string)
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

var mountPathRe = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)

func (s *Server) handleDiskAdd(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Storage string `json:"storage"`
		Size    int    `json:"size"` // GB
		Path    string `json:"path"` // só LXC
		Backup  bool   `json:"backup"`
	}
	if err := readJSON(r, &body); err != nil || body.Storage == "" || body.Size < 1 {
		writeErr(w, http.StatusBadRequest, "storage e tamanho obrigatórios")
		return
	}
	var raw map[string]any
	if err := s.pve.Get(r.Context(), &a, cfgPath(g), nil, &raw); err != nil {
		writePVEErr(w, err)
		return
	}
	prefix, value := "mp", ""
	if g.Type == "lxc" {
		if !mountPathRe.MatchString(body.Path) || body.Path == "/" {
			writeErr(w, http.StatusBadRequest, "caminho de montagem inválido (ex.: /data)")
			return
		}
		value = fmt.Sprintf("%s:%d,mp=%s,backup=%s", body.Storage, body.Size, body.Path, b01(body.Backup))
	} else {
		prefix = "scsi"
		value = fmt.Sprintf("%s:%d,backup=%s", body.Storage, body.Size, b01(body.Backup))
	}
	key := ""
	for i := 0; i < 256; i++ {
		if _, used := raw[fmt.Sprintf("%s%d", prefix, i)]; !used {
			key = fmt.Sprintf("%s%d", prefix, i)
			break
		}
	}
	if key == "" {
		writeErr(w, http.StatusConflict, "sem slot livre pra disco")
		return
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{key: {value}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid, "key": key})
}

func (s *Server) handleDiskMove(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Disk    string `json:"disk"`
		Storage string `json:"storage"`
	}
	if err := readJSON(r, &body); err != nil || !diskKeyRe.MatchString(body.Disk) || body.Storage == "" {
		writeErr(w, http.StatusBadRequest, "disco e storage obrigatórios")
		return
	}
	f := url.Values{"storage": {body.Storage}, "delete": {"1"}}
	path := pve.GuestPath(g.Node, g.Type, g.VMID)
	if g.Type == "lxc" {
		f.Set("volume", body.Disk)
		path += "/move_volume"
	} else {
		f.Set("disk", body.Disk)
		path += "/move_disk"
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, path, f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

// handleDiskRemove: disco anexado vira "unused" (desanexar); um "unused"
// removido é apagado do storage de vez.
func (s *Server) handleDiskRemove(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	disk := r.PathValue("disk")
	if !diskKeyRe.MatchString(disk) || disk == "rootfs" {
		writeErr(w, http.StatusBadRequest, "esse disco não pode ser removido")
		return
	}
	upid, err := s.putConfig(r.Context(), a, g, url.Values{"delete": {disk}})
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

func (s *Server) handleMigrate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	g, ok := s.guestFromPath(w, r, a)
	if !ok {
		return
	}
	var body struct {
		Target string `json:"target"`
	}
	if err := readJSON(r, &body); err != nil || body.Target == "" || body.Target == g.Node {
		writeErr(w, http.StatusBadRequest, "escolha outro nó")
		return
	}
	f := url.Values{"target": {body.Target}}
	if g.Status == "running" {
		if g.Type == "qemu" {
			// Ao vivo; discos locais vão junto.
			f.Set("online", "1")
			f.Set("with-local-disks", "1")
		} else {
			// LXC não migra ao vivo: desliga, move e liga de novo.
			f.Set("restart", "1")
		}
	}
	var upid string
	if err := s.pve.Post(r.Context(), &a, pve.GuestPath(g.Node, g.Type, g.VMID)+"/migrate", f, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]string{"upid": upid})
}

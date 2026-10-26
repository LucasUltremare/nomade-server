package server

import (
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

// --- tasks ---

// handleTask devolve status e log de uma task do PVE a partir da linha start;
// o front faz polling enquanto status for "running".
func (s *Server) handleTask(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	upid := r.PathValue("upid")
	node := pve.NodeOfUPID(upid)
	if node == "" {
		writeErr(w, http.StatusBadRequest, "upid inválido")
		return
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	st, err := s.pve.TaskStatus(r.Context(), &a, node, upid)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	lines, err := s.pve.TaskLog(r.Context(), &a, node, upid, start)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	if lines == nil {
		lines = []pve.TaskLine{}
	}
	if st.Status == "stopped" {
		s.cache.invalidate(a.User)
	}
	writeJSON(w, map[string]any{"status": st.Status, "exitstatus": st.ExitStatus, "lines": lines})
}

// --- criar LXC ---

type tmplView struct {
	Volid string `json:"volid"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
}

type aplView struct {
	Template string `json:"template"`
	OS       string `json:"os"`
	Version  string `json:"version"`
	Headline string `json:"headline"`
}

type storageOpt struct {
	Storage string `json:"storage"`
	Type    string `json:"type"`
	Avail   int64  `json:"avail"`
	Total   int64  `json:"total"`
}

type bridgeView struct {
	Iface    string `json:"iface"`
	CIDR     string `json:"cidr"`
	Comments string `json:"comments"`
}

func (s *Server) handleLXCOptions(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	node := r.PathValue("node")
	ctx := r.Context()
	out := struct {
		NextID     int          `json:"nextid"`
		Templates  []tmplView   `json:"templates"`
		Available  []aplView    `json:"available"`
		Rootfs     []storageOpt `json:"rootfs"`
		TmplStores []storageOpt `json:"templateStorages"`
		Bridges    []bridgeView `json:"bridges"`
	}{Templates: []tmplView{}, Available: []aplView{}, Rootfs: []storageOpt{}, TmplStores: []storageOpt{}, Bridges: []bridgeView{}}

	stores, err := s.pve.NodeStorage(ctx, &a, node, "")
	if err != nil {
		writePVEErr(w, err)
		return
	}
	for _, st := range stores {
		if !st.Active || !st.Enabled {
			continue
		}
		opt := storageOpt{Storage: st.Storage, Type: st.Type, Avail: st.Avail, Total: st.Total}
		if hasContent(st.Content, "rootdir") {
			out.Rootfs = append(out.Rootfs, opt)
		}
		if hasContent(st.Content, "vztmpl") {
			out.TmplStores = append(out.TmplStores, opt)
		}
	}

	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		apl []struct {
			Template string `json:"template"`
			OS       string `json:"os"`
			Version  string `json:"version"`
			Headline string `json:"headline"`
			Section  string `json:"section"`
		}
		ifaces []bridgeView
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		out.NextID, _ = s.pve.NextID(ctx, &a)
	}()
	go func() {
		defer wg.Done()
		s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(node)+"/aplinfo", nil, &apl)
	}()
	go func() {
		defer wg.Done()
		s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(node)+"/network", url.Values{"type": {"any_bridge"}}, &ifaces)
	}()
	for _, ts := range out.TmplStores {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var content []struct {
				Volid string `json:"volid"`
				Size  int64  `json:"size"`
			}
			path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(node), url.PathEscape(ts.Storage))
			if s.pve.Get(ctx, &a, path, url.Values{"content": {"vztmpl"}}, &content) == nil {
				mu.Lock()
				for _, c := range content {
					name := c.Volid[strings.LastIndex(c.Volid, "/")+1:]
					out.Templates = append(out.Templates, tmplView{Volid: c.Volid, Name: name, Size: c.Size})
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	for _, t := range apl {
		if t.Section == "system" {
			out.Available = append(out.Available, aplView{Template: t.Template, OS: t.OS, Version: t.Version, Headline: t.Headline})
		}
	}
	slices.SortFunc(out.Available, func(x, y aplView) int { return strings.Compare(y.Template, x.Template) })
	slices.SortFunc(out.Templates, func(x, y tmplView) int { return strings.Compare(y.Name, x.Name) })
	if ifaces != nil {
		out.Bridges = ifaces
	}
	slices.SortFunc(out.Bridges, func(x, y bridgeView) int { return strings.Compare(x.Iface, y.Iface) })
	writeJSON(w, out)
}

func hasContent(list, want string) bool {
	return slices.Contains(strings.Split(list, ","), want)
}

func (s *Server) handleTemplateDownload(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body struct {
		Storage  string `json:"storage"`
		Template string `json:"template"`
	}
	if err := readJSON(r, &body); err != nil || body.Storage == "" || body.Template == "" {
		writeErr(w, http.StatusBadRequest, "storage e template obrigatórios")
		return
	}
	var upid string
	err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/aplinfo",
		url.Values{"storage": {body.Storage}, "template": {body.Template}}, &upid)
	if err != nil {
		writePVEErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"upid": upid})
}

var hostnameRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

type lxcRequest struct {
	VMID         int    `json:"vmid"`
	Hostname     string `json:"hostname"`
	Template     string `json:"template"` // volid
	Cores        int    `json:"cores"`
	Memory       int    `json:"memory"` // MB
	Swap         int    `json:"swap"`
	Disk         int    `json:"disk"` // GB
	Storage      string `json:"storage"`
	Bridge       string `json:"bridge"`
	IP           string `json:"ip"` // "dhcp" ou CIDR
	Gateway      string `json:"gateway"`
	VLAN         int    `json:"vlan"`
	Password     string `json:"password"`
	SSHKeys      string `json:"sshKeys"`
	Unprivileged bool   `json:"unprivileged"`
	Nesting      bool   `json:"nesting"`
	Tun          bool   `json:"tun"`
	Start        bool   `json:"start"`
	OnBoot       bool   `json:"onboot"`
	Tags         string `json:"tags"`
}

func (q lxcRequest) form() (url.Values, error) {
	if !hostnameRe.MatchString(q.Hostname) {
		return nil, fmt.Errorf("hostname inválido (letras, números e hífen)")
	}
	if q.Template == "" || q.Storage == "" || q.Bridge == "" {
		return nil, fmt.Errorf("template, storage e bridge são obrigatórios")
	}
	if q.Password == "" && q.SSHKeys == "" {
		return nil, fmt.Errorf("defina uma senha ou uma chave SSH")
	}
	if q.Password != "" && len(q.Password) < 5 {
		return nil, fmt.Errorf("a senha precisa de pelo menos 5 caracteres")
	}
	f := url.Values{
		"vmid":         {strconv.Itoa(q.VMID)},
		"hostname":     {q.Hostname},
		"ostemplate":   {q.Template},
		"cores":        {strconv.Itoa(max(1, q.Cores))},
		"memory":       {strconv.Itoa(max(64, q.Memory))},
		"swap":         {strconv.Itoa(max(0, q.Swap))},
		"rootfs":       {fmt.Sprintf("%s:%d", q.Storage, max(1, q.Disk))},
		"unprivileged": {b01(q.Unprivileged)},
		"start":        {b01(q.Start)},
		"onboot":       {b01(q.OnBoot)},
		"description":  {"Criado pelo Mia"},
	}
	ip := "ip=dhcp"
	if q.IP != "" && q.IP != "dhcp" {
		if !strings.Contains(q.IP, "/") {
			return nil, fmt.Errorf("IP fixo precisa do prefixo, ex.: 10.0.10.50/24")
		}
		ip = "ip=" + q.IP
		if q.Gateway != "" {
			ip += ",gw=" + q.Gateway
		}
	}
	net0 := "name=eth0,bridge=" + q.Bridge + "," + ip
	if q.VLAN > 0 {
		net0 += ",tag=" + strconv.Itoa(q.VLAN)
	}
	f.Set("net0", net0)
	if q.Password != "" {
		f.Set("password", q.Password)
	}
	if q.SSHKeys != "" {
		f.Set("ssh-public-keys", q.SSHKeys)
	}
	if q.Nesting {
		f.Set("features", "nesting=1")
	}
	if q.Tun {
		f.Set("dev0", "/dev/net/tun")
	}
	if tags := strings.Trim(strings.ReplaceAll(q.Tags, " ", ""), ";,"); tags != "" {
		f.Set("tags", strings.ReplaceAll(tags, ",", ";"))
	}
	return f, nil
}

func b01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func (s *Server) handleLXCCreate(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	var body lxcRequest
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
	if err := s.pve.Post(r.Context(), &a, "/nodes/"+url.PathEscape(r.PathValue("node"))+"/lxc", form, &upid); err != nil {
		writePVEErr(w, err)
		return
	}
	s.cache.invalidate(a.User)
	writeJSON(w, map[string]any{"upid": upid, "vmid": body.VMID})
}

package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/LucasUltremare/nomade-server/internal/demo"
	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// newTestServer sobe o Mia contra o Proxmox falso do pacote demo.
func newTestServer(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	d := demo.Start()
	t.Cleanup(d.Close)
	s, err := New(Config{PVEURL: d.URL(), DataDir: t.TempDir(), Demo: true})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(s.routes())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	return ts, c
}

func call(t *testing.T, c *http.Client, method, url string, body any, out any) int {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, rd)
	req.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet {
		req.Header.Set("X-Mia", "1")
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func TestLoginAndOverview(t *testing.T) {
	ts, c := newTestServer(t)

	if code := call(t, c, "GET", ts.URL+"/api/overview", nil, nil); code != 401 {
		t.Fatalf("sem login: esperava 401, veio %d", code)
	}
	if code := call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "errada"}, nil); code != 401 {
		t.Fatalf("senha errada: esperava 401, veio %d", code)
	}
	var login struct {
		User string `json:"user"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, &login); code != 200 {
		t.Fatalf("login: %d", code)
	}
	if login.User != "root@pam" {
		t.Fatalf("realm padrão devia ser pam, veio %q", login.User)
	}

	var ov overview
	if code := call(t, c, "GET", ts.URL+"/api/overview?range=24h", nil, &ov); code != 200 {
		t.Fatalf("overview: %d", code)
	}
	if ov.Cluster.Name != "homelab" || ov.Cluster.Nodes != 3 || !ov.Cluster.Quorate || ov.Cluster.PVEVersion != "9.0.6" {
		t.Errorf("cluster: %+v", ov.Cluster)
	}
	if ov.Load.GuestsActive != 14 {
		t.Errorf("guests ativos: %d", ov.Load.GuestsActive)
	}
	if len(ov.Trend.T) < 200 || len(ov.Trend.T) != len(ov.Trend.CPU) || len(ov.Trend.T) != len(ov.Trend.RAM) {
		t.Errorf("trend com tamanhos estranhos: %d/%d/%d", len(ov.Trend.T), len(ov.Trend.CPU), len(ov.Trend.RAM))
	}
	if len(ov.Trend.Backups) == 0 {
		t.Error("devia ter janela de backup nas últimas 24h")
	}
	if ov.Trend.Peak == nil || len(ov.Trend.Peak.Top) == 0 {
		t.Errorf("pico sem guests: %+v", ov.Trend.Peak)
	}
	if len(ov.Samples) != 14 {
		t.Errorf("amostras de %d guests", len(ov.Samples))
	}
	if ov.Load.Delta == nil {
		t.Error("sem comparativo com o dia anterior")
	}
	if len(ov.Warnings) != 0 {
		t.Errorf("warnings: %v", ov.Warnings)
	}
}

func TestTFA(t *testing.T) {
	ts, c := newTestServer(t)
	var r struct {
		NeedTFA bool `json:"needTfa"`
	}
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "tfa-user", "password": "x"}, &r)
	if !r.NeedTFA {
		t.Fatal("devia pedir segundo fator")
	}
	if code := call(t, c, "GET", ts.URL+"/api/me", nil, nil); code != 401 {
		t.Fatalf("sessão pela metade não pode acessar: %d", code)
	}
	if code := call(t, c, "POST", ts.URL+"/api/login/tfa", map[string]string{"code": "000000"}, nil); code != 401 {
		t.Fatalf("código errado: %d", code)
	}
	if code := call(t, c, "POST", ts.URL+"/api/login/tfa", map[string]string{"code": "123456"}, nil); code != 200 {
		t.Fatalf("código certo: %d", code)
	}
	if code := call(t, c, "GET", ts.URL+"/api/me", nil, nil); code != 200 {
		t.Fatalf("depois do tfa: %d", code)
	}
}

func TestGuestActionAndFavorites(t *testing.T) {
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)

	// Escrita sem X-Mia é barrada.
	req, _ := http.NewRequest("POST", ts.URL+"/api/guests/qemu/110/start", nil)
	res, _ := c.Do(req)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("sem X-Mia: %d", res.StatusCode)
	}

	if code := call(t, c, "POST", ts.URL+"/api/guests/qemu/110/start", nil, nil); code != 200 {
		t.Fatalf("start: %d", code)
	}
	var guests []guestView
	call(t, c, "GET", ts.URL+"/api/guests", nil, &guests)
	for _, g := range guests {
		if g.VMID == 110 && g.Status != "running" {
			t.Errorf("110 devia estar rodando: %s", g.Status)
		}
	}
	if code := call(t, c, "POST", ts.URL+"/api/guests/qemu/110/rm-rf", nil, nil); code != 400 {
		t.Errorf("ação inválida: %d", code)
	}

	var me struct {
		Favorites []string `json:"favorites"`
	}
	call(t, c, "PUT", ts.URL+"/api/favorites", map[string][]string{"ids": {"lxc/103", "qemu/102"}}, nil)
	call(t, c, "GET", ts.URL+"/api/me", nil, &me)
	if len(me.Favorites) != 2 || me.Favorites[0] != "lxc/103" {
		t.Errorf("favoritos: %v", me.Favorites)
	}
}

func TestBackupWindows(t *testing.T) {
	tasks := []pve.Task{
		{StartTime: 100, EndTime: 200},
		{StartTime: 500, EndTime: 900}, // a menos de 10 min do anterior: junta
		{StartTime: 5000, EndTime: 0},  // rodando
		{StartTime: 10, EndTime: 50},   // antes da janela
	}
	got := backupWindows(tasks, 80, 6000)
	want := [][2]int64{{100, 900}, {5000, 6000}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestCleanModel(t *testing.T) {
	for in, want := range map[string]string{
		"AMD Ryzen 9 5900X 12-Core Processor":       "Ryzen 9 5900X",
		"12th Gen Intel(R) Core(TM) i7-12700":       "Core i7-12700",
		"Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz": "Xeon E5-2680 v4",
		"Intel(R) N100": "N100",
	} {
		if got := cleanModel(in); got != want {
			t.Errorf("cleanModel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConsoleProxy(t *testing.T) {
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)

	var open struct {
		Port   int    `json:"port"`
		Ticket string `json:"ticket"`
		User   string `json:"user"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/console", map[string]any{"node": "pve-01", "kind": "node"}, &open); code != 200 {
		t.Fatalf("console: %d", code)
	}
	wsURL := strings.Replace(ts.URL, "https://", "wss://", 1) + "/api/console/ws?" + url.Values{
		"node": {"pve-01"}, "kind": {"node"}, "port": {strconv.Itoa(open.Port)}, "vncticket": {open.Ticket},
	}.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: c, Subprotocols: []string{"binary"}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()
	ws.Write(ctx, websocket.MessageText, []byte(open.User+":"+open.Ticket+"\n"))
	_, first, err := ws.Read(ctx)
	if err != nil || string(first[:2]) != "OK" {
		t.Fatalf("esperava OK, veio %q (%v)", first, err)
	}
	ws.Write(ctx, websocket.MessageText, []byte("0:11:pveversion\r"))
	var got strings.Builder
	for !strings.Contains(got.String(), "pve-manager/") {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("lendo: %v (até agora: %q)", err, got.String())
		}
		got.Write(msg)
	}
}

func TestCreateLXCAndTask(t *testing.T) {
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)

	var opts struct {
		NextID    int `json:"nextid"`
		Templates []struct {
			Volid string `json:"volid"`
		} `json:"templates"`
		Rootfs []struct {
			Storage string `json:"storage"`
		} `json:"rootfs"`
		Bridges []struct {
			Iface string `json:"iface"`
		} `json:"bridges"`
	}
	call(t, c, "GET", ts.URL+"/api/nodes/pve-01/lxc-options", nil, &opts)
	if opts.NextID < 100 || len(opts.Templates) == 0 || len(opts.Rootfs) == 0 || len(opts.Bridges) == 0 {
		t.Fatalf("opções incompletas: %+v", opts)
	}
	body := map[string]any{"vmid": opts.NextID, "hostname": "teste", "template": opts.Templates[0].Volid,
		"cores": 2, "memory": 1024, "disk": 8, "storage": opts.Rootfs[0].Storage, "bridge": opts.Bridges[0].Iface,
		"ip": "dhcp", "password": "segredo123", "unprivileged": true, "start": true}
	if code := call(t, c, "POST", ts.URL+"/api/nodes/pve-01/lxc", map[string]any{"hostname": "x y"}, nil); code != 400 {
		t.Errorf("hostname inválido devia dar 400, deu %d", code)
	}
	var created struct {
		UPID string `json:"upid"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/nodes/pve-01/lxc", body, &created); code != 200 {
		t.Fatalf("criar: %d", code)
	}
	var task struct {
		Status string `json:"status"`
		Lines  []struct {
			T string `json:"t"`
		} `json:"lines"`
	}
	deadline := time.Now().Add(10 * time.Second)
	for task.Status != "stopped" && time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		call(t, c, "GET", ts.URL+"/api/tasks/"+url.PathEscape(created.UPID), nil, &task)
	}
	if task.Status != "stopped" {
		t.Fatal("task não terminou")
	}
	time.Sleep(200 * time.Millisecond)
	var guests []guestView
	call(t, c, "GET", ts.URL+"/api/guests", nil, &guests)
	if !slices.ContainsFunc(guests, func(g guestView) bool { return g.Name == "teste" && g.Status == "running" }) {
		t.Error("CT novo não apareceu rodando")
	}
}

func TestNetworkPendingAndApply(t *testing.T) {
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)
	if code := call(t, c, "POST", ts.URL+"/api/nodes/pve-02/network", map[string]any{"type": "bridge", "iface": "eth9"}, nil); code != 400 {
		t.Errorf("bridge sem vmbr devia dar 400: %d", code)
	}
	if code := call(t, c, "POST", ts.URL+"/api/nodes/pve-02/network", map[string]any{"type": "bridge", "iface": "vmbr9", "comments": "lab"}, nil); code != 200 {
		t.Fatalf("criar bridge: %d", code)
	}
	var net struct {
		Ifaces  []ifaceView `json:"ifaces"`
		Changes string      `json:"changes"`
	}
	call(t, c, "GET", ts.URL+"/api/nodes/pve-02/network", nil, &net)
	if !strings.Contains(net.Changes, "vmbr9") {
		t.Errorf("mudança pendente não aparece: %q", net.Changes)
	}
	call(t, c, "POST", ts.URL+"/api/nodes/pve-02/network/apply", nil, nil)
	call(t, c, "GET", ts.URL+"/api/nodes/pve-02/network", nil, &net)
	if net.Changes != "" || !slices.ContainsFunc(net.Ifaces, func(i ifaceView) bool { return i.Iface == "vmbr9" }) {
		t.Errorf("depois de aplicar: changes=%q", net.Changes)
	}
}

func TestTailscaleNeedsRootAndKey(t *testing.T) {
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "fulano@pve", "password": "x"}, nil)
	if code := call(t, c, "PUT", ts.URL+"/api/settings/tailscale", map[string]string{"authKey": "tskey-auth-abc123456789"}, nil); code != 403 {
		t.Errorf("não-root devia dar 403: %d", code)
	}
	call(t, c, "POST", ts.URL+"/api/logout", nil, nil)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)
	req := map[string]any{"action": "expose", "vmid": 101, "hostname": "jellyfin", "port": 8096}
	if code := call(t, c, "POST", ts.URL+"/api/tailscale/command", req, nil); code != 412 {
		t.Errorf("sem chave devia dar 412: %d", code)
	}
	if code := call(t, c, "PUT", ts.URL+"/api/settings/tailscale", map[string]string{"authKey": "não é chave"}, nil); code != 400 {
		t.Errorf("chave inválida devia dar 400: %d", code)
	}
	call(t, c, "PUT", ts.URL+"/api/settings/tailscale", map[string]string{"authKey": "tskey-auth-abc123456789"}, nil)
	var out struct {
		Command string `json:"command"`
	}
	call(t, c, "POST", ts.URL+"/api/tailscale/command", req, &out)
	if !strings.HasPrefix(out.Command, " CTID=101;") || !strings.Contains(out.Command, "tailscale serve --bg 8096") {
		t.Errorf("comando: %q", out.Command)
	}
	var gw struct {
		Command string `json:"command"`
	}
	call(t, c, "POST", ts.URL+"/api/tailscale/command", map[string]any{"action": "gateway", "node": "pve-01", "hostname": "homelab-gw"}, &gw)
	if !strings.Contains(gw.Command, "--advertise-routes=10.0.10.0/24") || !strings.Contains(gw.Command, "--dev0 /dev/net/tun") {
		t.Errorf("gateway: %q", gw.Command)
	}
}

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		l, c string
		want bool
	}{{"v0.2.0", "v0.1.0", true}, {"v0.1.0", "v0.1.0", false}, {"v0.1.10", "v0.1.9", true}, {"v1.0.0", "dev", false}, {"", "v0.1.0", false}} {
		if got := newer(c.l, c.c); got != c.want {
			t.Errorf("newer(%q,%q)=%v", c.l, c.c, got)
		}
	}
}

func loginRoot(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	ts, c := newTestServer(t)
	call(t, c, "POST", ts.URL+"/api/login", map[string]string{"username": "root", "password": "x"}, nil)
	return ts, c
}

func waitTask(t *testing.T, ts *httptest.Server, c *http.Client, upid string) string {
	t.Helper()
	var st struct {
		Status     string `json:"status"`
		ExitStatus string `json:"exitstatus"`
	}
	for i := 0; i < 50 && st.Status != "stopped"; i++ {
		time.Sleep(200 * time.Millisecond)
		call(t, c, "GET", ts.URL+"/api/tasks/"+url.PathEscape(upid), nil, &st)
	}
	time.Sleep(100 * time.Millisecond)
	return st.ExitStatus
}

func TestGuestDisks(t *testing.T) {
	ts, c := loginRoot(t)
	var cfg guestConfig
	call(t, c, "GET", ts.URL+"/api/guests/lxc/101/config", nil, &cfg)
	if len(cfg.Disks) != 2 || cfg.Disks[0].Key != "rootfs" || cfg.Disks[1].Mountpoint != "/media" {
		t.Fatalf("discos: %+v", cfg.Disks)
	}
	root := cfg.Disks[0].Size

	var up struct {
		UPID string `json:"upid"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/guests/lxc/101/disks/resize", map[string]any{"disk": "rootfs", "add": 4}, &up); code != 200 {
		t.Fatalf("resize: %d", code)
	}
	waitTask(t, ts, c, up.UPID)
	call(t, c, "GET", ts.URL+"/api/guests/lxc/101/config", nil, &cfg)
	if cfg.Disks[0].Size != root+4<<30 {
		t.Errorf("rootfs não cresceu: %d -> %d", root, cfg.Disks[0].Size)
	}

	if code := call(t, c, "POST", ts.URL+"/api/guests/lxc/101/disks/add", map[string]any{"storage": "tank", "size": 10, "path": "../etc"}, nil); code != 400 {
		t.Errorf("caminho inválido devia dar 400: %d", code)
	}
	var added struct {
		Key string `json:"key"`
	}
	call(t, c, "POST", ts.URL+"/api/guests/lxc/101/disks/add", map[string]any{"storage": "tank", "size": 10, "path": "/data", "backup": true}, &added)
	if added.Key != "mp1" {
		t.Errorf("novo ponto de montagem devia ser mp1, veio %q", added.Key)
	}
	// Desanexar vira unused; remover o unused apaga.
	call(t, c, "DELETE", ts.URL+"/api/guests/lxc/101/disks/mp1", nil, nil)
	call(t, c, "GET", ts.URL+"/api/guests/lxc/101/config", nil, &cfg)
	if !slices.ContainsFunc(cfg.Disks, func(d diskView) bool { return d.Unused }) {
		t.Fatalf("mp1 devia virar unused: %+v", cfg.Disks)
	}
	if code := call(t, c, "DELETE", ts.URL+"/api/guests/lxc/101/disks/rootfs", nil, nil); code != 400 {
		t.Errorf("rootfs não pode ser removido: %d", code)
	}

	// LXC rodando não move volume: o erro do PVE chega no front.
	if code := call(t, c, "POST", ts.URL+"/api/guests/lxc/101/disks/move", map[string]any{"disk": "rootfs", "storage": "local"}, nil); code == 200 {
		t.Error("mover rootfs de CT rodando devia falhar")
	}

	call(t, c, "PUT", ts.URL+"/api/guests/lxc/104/resources", map[string]any{"cores": 3, "memory": 3072, "swap": 256}, nil)
	call(t, c, "GET", ts.URL+"/api/guests/lxc/104/config", nil, &cfg)
	if cfg.Cores != 3 || cfg.Memory != 3072 || cfg.Swap != 256 {
		t.Errorf("recursos: %+v", cfg)
	}
}

func TestMigrate(t *testing.T) {
	ts, c := loginRoot(t)
	var up struct {
		UPID string `json:"upid"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/guests/lxc/104/migrate", map[string]string{"target": "pve-01"}, nil); code != 400 {
		t.Errorf("migrar pro mesmo nó devia dar 400: %d", code)
	}
	call(t, c, "POST", ts.URL+"/api/guests/lxc/104/migrate", map[string]string{"target": "pve-02"}, &up)
	if exit := waitTask(t, ts, c, up.UPID); exit != "OK" {
		t.Fatalf("migração: %q", exit)
	}
	var guests []guestView
	call(t, c, "GET", ts.URL+"/api/guests", nil, &guests)
	if i := slices.IndexFunc(guests, func(g guestView) bool { return g.VMID == 104 }); guests[i].Node != "pve-02" {
		t.Errorf("104 devia estar no pve-02, está no %s", guests[i].Node)
	}
}

func TestHealth(t *testing.T) {
	ts, c := loginRoot(t)
	var rep healthReport
	call(t, c, "GET", ts.URL+"/api/health", nil, &rep)
	has := func(area, contains string) bool {
		return slices.ContainsFunc(rep.Checks, func(x check) bool { return x.Area == area && strings.Contains(x.Title+x.Detail, contains) })
	}
	if !has("discos", "CT1000P3") {
		t.Error("SSD desgastado do pve-02 não apareceu")
	}
	if !has("certificados", "pveproxy-ssl.pem") {
		t.Error("certificado vencendo não apareceu")
	}
	if !has("atualizações", "pve-manager") {
		t.Error("atualizações do pve-01 não apareceram")
	}
	if !has("backups", "win11-lab") {
		t.Error("guest sem backup não apareceu")
	}
	if len(rep.Disks) != 6 || len(rep.Services) == 0 {
		t.Errorf("discos=%d serviços=%d", len(rep.Disks), len(rep.Services))
	}
	if rep.Checks[0].Level == "ok" {
		t.Error("ordem errada")
	}
}

func TestBackupJobs(t *testing.T) {
	ts, c := loginRoot(t)
	var jobs []backupJob
	call(t, c, "GET", ts.URL+"/api/backup/jobs", nil, &jobs)
	daily := slices.IndexFunc(jobs, func(j backupJob) bool { return j.All })
	if len(jobs) != 2 || daily < 0 || jobs[daily].Retention.Daily != 7 || jobs[daily].Exclude[0] != 110 {
		t.Fatalf("jobs: %+v", jobs)
	}
	dailyID := jobs[daily].ID
	novo := backupJob{Schedule: "sun 03:00", Storage: "local", Mode: "snapshot", VMIDs: []int{110}, Enabled: true, Retention: retention{Last: 2}}
	if code := call(t, c, "POST", ts.URL+"/api/backup/jobs", novo, nil); code != 200 {
		t.Fatalf("criar: %d", code)
	}
	if code := call(t, c, "POST", ts.URL+"/api/backup/jobs", backupJob{Schedule: "daily; reboot", Storage: "local", All: true}, nil); code != 400 {
		t.Errorf("agendamento inválido devia dar 400: %d", code)
	}
	call(t, c, "GET", ts.URL+"/api/backup/jobs", nil, &jobs)
	if len(jobs) != 3 {
		t.Fatalf("esperava 3 jobs, veio %d", len(jobs))
	}
	var st []guestBackup
	call(t, c, "GET", ts.URL+"/api/backup/status", nil, &st)
	i := slices.IndexFunc(st, func(b guestBackup) bool { return b.VMID == 110 })
	if i < 0 || !st[i].Covered {
		t.Errorf("110 devia estar coberto pelo job novo: %+v", st[i])
	}
	j := slices.IndexFunc(st, func(b guestBackup) bool { return b.VMID == 101 })
	if st[j].Last == 0 || st[j].Count == 0 {
		t.Errorf("101 devia ter backups: %+v", st[j])
	}

	off := jobs[slices.IndexFunc(jobs, func(j backupJob) bool { return j.ID == dailyID })]
	off.Enabled = false
	call(t, c, "PUT", ts.URL+"/api/backup/jobs/"+off.ID, off, nil)
	var run struct {
		Tasks []struct {
			Node, UPID, Error string
		} `json:"tasks"`
	}
	call(t, c, "POST", ts.URL+"/api/backup/jobs/"+off.ID+"/run", nil, &run)
	if len(run.Tasks) != 3 {
		t.Errorf("job com todos devia rodar nos 3 nós: %+v", run.Tasks)
	}
	call(t, c, "GET", ts.URL+"/api/backup/jobs", nil, &jobs)
	if jobs[slices.IndexFunc(jobs, func(j backupJob) bool { return j.ID == dailyID })].Enabled {
		t.Error("job devia estar desligado")
	}
	call(t, c, "DELETE", ts.URL+"/api/backup/jobs/"+dailyID, nil, nil)
	call(t, c, "GET", ts.URL+"/api/backup/jobs", nil, &jobs)
	if len(jobs) != 2 {
		t.Errorf("depois de apagar: %d", len(jobs))
	}
}

func TestFirewall(t *testing.T) {
	ts, c := loginRoot(t)
	var fw struct {
		Enable      bool     `json:"enable"`
		Rules       []fwRule `json:"rules"`
		MiaPortOpen bool     `json:"miaPortOpen"`
	}
	call(t, c, "GET", ts.URL+"/api/firewall?scope=cluster", nil, &fw)
	if fw.Enable || len(fw.Rules) != 2 || fw.MiaPortOpen {
		t.Fatalf("estado inicial: %+v", fw)
	}
	if code := call(t, c, "POST", ts.URL+"/api/firewall/rules?scope=cluster", fwRule{Type: "in", Action: "ACCEPT", Dport: "8443; rm", Enable: true}, nil); code != 400 {
		t.Errorf("porta com lixo devia dar 400: %d", code)
	}
	call(t, c, "POST", ts.URL+"/api/firewall/rules?scope=cluster", fwRule{Type: "in", Action: "ACCEPT", Proto: "tcp", Dport: "8443", Comment: "Mia", Enable: true}, nil)
	call(t, c, "GET", ts.URL+"/api/firewall?scope=cluster", nil, &fw)
	if !fw.MiaPortOpen || fw.Rules[0].Comment != "Mia" {
		t.Errorf("regra do Mia: %+v", fw)
	}
	call(t, c, "PUT", ts.URL+"/api/firewall/rules/0?scope=cluster", map[string]bool{"enable": false}, nil)
	call(t, c, "GET", ts.URL+"/api/firewall?scope=cluster", nil, &fw)
	if fw.MiaPortOpen {
		t.Error("regra desligada não devia contar")
	}
	call(t, c, "DELETE", ts.URL+"/api/firewall/rules/0?scope=cluster", nil, nil)
	call(t, c, "PUT", ts.URL+"/api/firewall/options?scope=guest&kind=lxc&vmid=104", map[string]any{"enable": true}, nil)
	call(t, c, "GET", ts.URL+"/api/firewall?scope=guest&kind=lxc&vmid=104", nil, &fw)
	if !fw.Enable || len(fw.Rules) != 0 {
		t.Errorf("guest: %+v", fw)
	}
}

func TestTaskListAndStop(t *testing.T) {
	ts, c := loginRoot(t)
	var up struct {
		UPID string `json:"upid"`
	}
	call(t, c, "POST", ts.URL+"/api/guests/lxc/104/migrate", map[string]string{"target": "pve-03"}, &up)
	var tasks []taskRow
	call(t, c, "GET", ts.URL+"/api/tasks", nil, &tasks)
	if len(tasks) < 5 || tasks[0].StartTime < tasks[len(tasks)-1].StartTime {
		t.Fatalf("lista/ordem: %d", len(tasks))
	}
	if !slices.ContainsFunc(tasks, func(x taskRow) bool { return x.Status == "job errors" }) {
		t.Error("task com erro do demo não apareceu")
	}
	call(t, c, "DELETE", ts.URL+"/api/tasks/"+url.PathEscape(up.UPID), nil, nil)
	if exit := waitTask(t, ts, c, up.UPID); exit != "interrupted by signal" {
		t.Errorf("parar task: %q", exit)
	}
}

// O PVE manda ctime/size como texto em alguns storages (ex.: PBS); quebrou
// a tela de Armazenamento na v0.3.0.
func TestStorageContentStringNumbers(t *testing.T) {
	ts, c := loginRoot(t)
	var vols []volumeView
	if code := call(t, c, "GET", ts.URL+"/api/storage/pve-01/nas-backup/content", nil, &vols); code != 200 {
		t.Fatalf("conteúdo do nas-backup: %d", code)
	}
	if len(vols) == 0 || vols[0].CTime == 0 || vols[0].Size == 0 {
		t.Fatalf("ctime/size não foram lidos: %+v", vols)
	}
}

func TestSnapshots(t *testing.T) {
	ts, c := loginRoot(t)
	var snaps []snapshotView
	call(t, c, "GET", ts.URL+"/api/guests/qemu/102/snapshots", nil, &snaps)
	if len(snaps) != 3 || !snaps[2].Current || snaps[0].Name != "antes_upgrade" || !snaps[0].RAM {
		t.Fatalf("snapshots: %+v", snaps)
	}
	if code := call(t, c, "POST", ts.URL+"/api/guests/qemu/102/snapshots", map[string]any{"name": "1nome"}, nil); code != 400 {
		t.Errorf("nome inválido: %d", code)
	}
	var up struct {
		UPID string `json:"upid"`
	}
	call(t, c, "POST", ts.URL+"/api/guests/qemu/102/snapshots", map[string]any{"name": "teste_mia", "description": "via teste", "ram": true}, &up)
	waitTask(t, ts, c, up.UPID)
	call(t, c, "GET", ts.URL+"/api/guests/qemu/102/snapshots", nil, &snaps)
	if len(snaps) != 4 || snaps[2].Name != "teste_mia" || snaps[2].Parent != "build_ok" {
		t.Fatalf("depois de criar: %+v", snaps)
	}
	call(t, c, "POST", ts.URL+"/api/guests/qemu/102/snapshots/teste_mia/rollback", nil, &up)
	if exit := waitTask(t, ts, c, up.UPID); exit != "OK" {
		t.Errorf("rollback: %q", exit)
	}
	call(t, c, "DELETE", ts.URL+"/api/guests/qemu/102/snapshots/build_ok", nil, &up)
	waitTask(t, ts, c, up.UPID)
	call(t, c, "GET", ts.URL+"/api/guests/qemu/102/snapshots", nil, &snaps)
	if len(snaps) != 3 || snaps[1].Parent != "antes_upgrade" {
		t.Errorf("apagar devia religar o filho: %+v", snaps)
	}
}

func TestVMLifecycle(t *testing.T) {
	ts, c := loginRoot(t)
	var opts struct {
		NextID int `json:"nextid"`
		ISOs   []struct {
			Volid string `json:"volid"`
		} `json:"isos"`
		Disks []struct {
			Storage string `json:"storage"`
		} `json:"disks"`
	}
	call(t, c, "GET", ts.URL+"/api/nodes/pve-01/vm-options", nil, &opts)
	if opts.NextID < 100 || len(opts.ISOs) < 2 || len(opts.Disks) == 0 {
		t.Fatalf("opções: %+v", opts)
	}
	f, err := vmRequest{VMID: 200, Name: "win", OS: "win11", Disk: 64, Storage: "tank", Bridge: "vmbr0", Cores: 4, Memory: 8192}.form()
	if err != nil || f.Get("tpmstate0") == "" || f.Get("bios") != "ovmf" || f.Get("sata0") == "" || f.Get("scsi0") != "" {
		t.Fatalf("form do windows 11: %v %v", err, f)
	}
	var created struct {
		UPID string `json:"upid"`
		VMID int    `json:"vmid"`
	}
	body := map[string]any{"name": "debian-vm", "os": "linux", "iso": opts.ISOs[0].Volid, "cores": 2, "memory": 2048,
		"disk": 20, "storage": opts.Disks[0].Storage, "bridge": "vmbr0", "start": false}
	if code := call(t, c, "POST", ts.URL+"/api/nodes/pve-01/qemu", body, &created); code != 200 {
		t.Fatalf("criar vm: %d", code)
	}
	waitTask(t, ts, c, created.UPID)
	id := strconv.Itoa(created.VMID)

	if code := call(t, c, "PUT", ts.URL+"/api/guests/qemu/"+id+"/cdrom", map[string]string{"iso": ""}, nil); code != 200 {
		t.Errorf("ejetar cd: %d", code)
	}
	var cl struct {
		UPID string `json:"upid"`
		VMID int    `json:"vmid"`
	}
	call(t, c, "POST", ts.URL+"/api/guests/qemu/"+id+"/clone", map[string]any{"name": "debian-copia", "full": true}, &cl)
	waitTask(t, ts, c, cl.UPID)
	if code := call(t, c, "POST", ts.URL+"/api/guests/qemu/"+id+"/template", nil, nil); code != 200 {
		t.Errorf("virar template: %d", code)
	}
	var guests []guestView
	call(t, c, "GET", ts.URL+"/api/guests", nil, &guests)
	if !slices.ContainsFunc(guests, func(g guestView) bool { return g.VMID == created.VMID && g.Template }) ||
		!slices.ContainsFunc(guests, func(g guestView) bool { return g.VMID == cl.VMID && g.Name == "debian-copia" }) {
		t.Fatalf("template/clone: %+v", guests)
	}
	if code := call(t, c, "DELETE", ts.URL+"/api/guests/qemu/"+strconv.Itoa(cl.VMID), map[string]string{"confirm": "errado"}, nil); code != 400 {
		t.Errorf("apagar sem confirmar devia dar 400: %d", code)
	}
	var del struct {
		UPID string `json:"upid"`
	}
	call(t, c, "DELETE", ts.URL+"/api/guests/qemu/"+strconv.Itoa(cl.VMID), map[string]string{"confirm": "debian-copia"}, &del)
	waitTask(t, ts, c, del.UPID)
	call(t, c, "GET", ts.URL+"/api/guests", nil, &guests)
	if slices.ContainsFunc(guests, func(g guestView) bool { return g.VMID == cl.VMID }) {
		t.Error("clone devia ter sido apagado")
	}
	if code := call(t, c, "DELETE", ts.URL+"/api/guests/qemu/102", map[string]string{"confirm": "vlad"}, nil); code != 409 {
		t.Errorf("apagar VM ligada devia dar 409: %d", code)
	}
}

func TestGuestRRD(t *testing.T) {
	ts, c := loginRoot(t)
	var rrd struct {
		T      []int64   `json:"t"`
		CPU    []float64 `json:"cpu"`
		NetIn  []float64 `json:"netin"`
		MaxMem float64   `json:"maxmem"`
	}
	call(t, c, "GET", ts.URL+"/api/guests/lxc/101/rrd?range=1h", nil, &rrd)
	if len(rrd.T) < 50 || len(rrd.CPU) != len(rrd.T) || len(rrd.NetIn) != len(rrd.T) || rrd.MaxMem == 0 {
		t.Fatalf("rrd: %d pontos", len(rrd.T))
	}
}

// O console de VM passa VNC cru pelo proxy: confere o handshake RFB.
func TestVNCProxy(t *testing.T) {
	ts, c := loginRoot(t)
	var open struct {
		Port   int    `json:"port"`
		Ticket string `json:"ticket"`
	}
	if code := call(t, c, "POST", ts.URL+"/api/console", map[string]any{"node": "pve-01", "kind": "qemu", "vmid": 102}, &open); code != 200 {
		t.Fatalf("vncproxy: %d", code)
	}
	wsURL := strings.Replace(ts.URL, "https://", "wss://", 1) + "/api/console/ws?" + url.Values{
		"node": {"pve-01"}, "kind": {"qemu"}, "vmid": {"102"}, "port": {strconv.Itoa(open.Port)}, "vncticket": {open.Ticket},
	}.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: c, Subprotocols: []string{"binary"}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()
	conn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	ver := make([]byte, 12)
	if _, err := io.ReadFull(conn, ver); err != nil || string(ver) != "RFB 003.008\n" {
		t.Fatalf("versão: %q %v", ver, err)
	}
	conn.Write(ver)
	sec := make([]byte, 2)
	io.ReadFull(conn, sec)
	conn.Write([]byte{2})
	io.ReadFull(conn, make([]byte, 16))
	conn.Write(make([]byte, 16))
	res := make([]byte, 4)
	io.ReadFull(conn, res)
	conn.Write([]byte{1})
	init := make([]byte, 24)
	if _, err := io.ReadFull(conn, init); err != nil {
		t.Fatalf("ServerInit: %v", err)
	}
	if w := int(init[0])<<8 | int(init[1]); w != 1024 || res[3] != 0 {
		t.Errorf("largura %d, resultado %v", w, res)
	}
}

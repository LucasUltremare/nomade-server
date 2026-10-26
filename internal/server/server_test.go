package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
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

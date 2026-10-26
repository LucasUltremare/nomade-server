package server

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"

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

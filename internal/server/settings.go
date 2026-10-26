package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

// Coisas que só root@pam mexe: chave do Tailscale e atualização do Mia.
// Os comandos de Tailscale rodam no console do nó (como os scripts do
// community-scripts), então só fazem sentido pra quem tem shell de root.

func isRoot(a pve.Auth) bool { return a.User == "root@pam" }

func requireRoot(w http.ResponseWriter, a pve.Auth) bool {
	if !isRoot(a) {
		writeErr(w, http.StatusForbidden, "só root@pam pode fazer isso")
		return false
	}
	return true
}

// --- Tailscale ---

var tsKeyRe = regexp.MustCompile(`^tskey-[A-Za-z0-9-]{10,200}$`)

func keyHint(k string) string {
	if len(k) < 12 {
		return ""
	}
	return k[:10] + "…" + k[len(k)-4:]
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	key := s.state.tailscaleKey()
	writeJSON(w, map[string]any{
		"root": isRoot(a),
		"tailscale": map[string]any{
			"configured": key != "",
			"hint":       keyHint(key),
		},
	})
}

func (s *Server) handleTailscaleKey(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	var body struct {
		AuthKey string `json:"authKey"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	body.AuthKey = strings.TrimSpace(body.AuthKey)
	if body.AuthKey != "" && !tsKeyRe.MatchString(body.AuthKey) {
		writeErr(w, http.StatusBadRequest, "isso não parece uma auth key do Tailscale (tskey-auth-…)")
		return
	}
	if err := s.state.setTailscaleKey(body.AuthKey); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.handleSettings(w, r, a)
}

var tsHostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// handleTailscaleCommand monta o script que o front digita no console do nó.
//
//	gateway: cria um LXC Debian com /dev/net/tun e sobe o Tailscale como
//	         subnet router da rede da bridge (todo o homelab na VPN).
//	expose:  instala o Tailscale dentro de um LXC e publica uma porta com
//	         `tailscale serve` em https://<nome>.<tailnet>.ts.net.
//	         target "byname" acha o CT pelo hostname (usado logo depois de
//	         instalar um app da loja, quando o ID ainda não é conhecido).
func (s *Server) handleTailscaleCommand(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	key := s.state.tailscaleKey()
	if key == "" {
		writeErr(w, http.StatusPreconditionFailed, "configure uma auth key do Tailscale primeiro")
		return
	}
	var body struct {
		Action   string `json:"action"`
		Node     string `json:"node"`
		VMID     int    `json:"vmid"`
		Hostname string `json:"hostname"` // nome na tailnet
		ByName   string `json:"byName"`   // hostname do CT a procurar
		Port     int    `json:"port"`
		Bridge   string `json:"bridge"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "json inválido")
		return
	}
	body.Hostname = strings.ToLower(body.Hostname)
	if !tsHostRe.MatchString(body.Hostname) {
		writeErr(w, http.StatusBadRequest, "nome inválido pra tailnet (minúsculas, números e hífen)")
		return
	}
	switch body.Action {
	case "gateway":
		cmd, err := s.gatewayScript(r.Context(), a, body.Node, body.Bridge, body.Hostname, key)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"command": cmd})
	case "expose":
		if body.Port < 1 || body.Port > 65535 {
			writeErr(w, http.StatusBadRequest, "porta inválida")
			return
		}
		target := strconv.Itoa(body.VMID)
		if body.VMID == 0 {
			if !tsHostRe.MatchString(strings.ToLower(body.ByName)) {
				writeErr(w, http.StatusBadRequest, "informe o CT")
				return
			}
			// O último CT com esse hostname (o recém-criado pelo script).
			target = fmt.Sprintf(`$(pct list | awk -v h=%q '$NF==h{id=$1} END{print id}')`, body.ByName)
		}
		writeJSON(w, map[string]string{"command": exposeScript(target, body.Hostname, body.Port, key)})
	default:
		writeErr(w, http.StatusBadRequest, "ação inválida")
	}
}

// Os scripts começam com espaço: com HISTCONTROL=ignoreboth (padrão do
// Debian) a linha com a auth key não fica no histórico do root.

func exposeScript(target, hostname string, port int, key string) string {
	return fmt.Sprintf(` CTID=%s; [ -n "$CTID" ] || echo "CT não encontrado"; [ -n "$CTID" ] && pct exec "$CTID" -- sh -s <<'MIA_TS'
echo "==> Tailscale no CT $(hostname)"
if ! command -v tailscale >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; } || apk add --no-cache curl
  curl -fsSL https://tailscale.com/install.sh | sh || true
fi
command -v tailscale >/dev/null 2>&1 || { echo "Não consegui instalar o Tailscale"; exit 1; }
# Sem /dev/net/tun (CT sem privilégio) o tailscaled roda em userspace; serve funciona igual.
if [ ! -e /dev/net/tun ] && [ -f /etc/default/tailscaled ]; then
  sed -i 's/^FLAGS=.*/FLAGS="--tun=userspace-networking"/' /etc/default/tailscaled
  systemctl restart tailscaled
  sleep 2
fi
tailscale up --auth-key=%s --hostname=%s || exit 1
tailscale serve --bg %d || exit 1
tailscale serve status
MIA_TS
`, target, key, hostname, port)
}

func (s *Server) gatewayScript(ctx context.Context, a pve.Auth, node, bridge, hostname, key string) (string, error) {
	if node == "" {
		return "", fmt.Errorf("escolha o nó")
	}
	if bridge == "" {
		bridge = "vmbr0"
	}
	var ifaces []bridgeView
	if err := s.pve.Get(ctx, &a, "/nodes/"+url.PathEscape(node)+"/network", url.Values{"type": {"any_bridge"}}, &ifaces); err != nil {
		return "", err
	}
	subnet := ""
	for _, i := range ifaces {
		if i.Iface == bridge && i.CIDR != "" {
			if _, n, err := net.ParseCIDR(i.CIDR); err == nil {
				subnet = n.String()
			}
		}
	}
	if subnet == "" {
		return "", fmt.Errorf("a bridge %s não tem IP; não sei qual rede anunciar", bridge)
	}
	stores, err := s.pve.NodeStorage(ctx, &a, node, "")
	if err != nil {
		return "", err
	}
	rootfs, tmpl := "", ""
	for _, st := range stores {
		if !st.Active || !st.Enabled {
			continue
		}
		if rootfs == "" && hasContent(st.Content, "rootdir") {
			rootfs = st.Storage
		}
		if tmpl == "" && hasContent(st.Content, "vztmpl") {
			tmpl = st.Storage
		}
	}
	if rootfs == "" || tmpl == "" {
		return "", fmt.Errorf("o nó precisa de um storage pra containers e outro pra templates")
	}
	return fmt.Sprintf(` bash <<'MIA_GW'
set -e
echo "==> Gateway Tailscale (%[1]s) anunciando %[2]s"
pveam update >/dev/null
T=$(pveam available --section system | awk '/debian-13-standard/{print $2}' | sort | tail -1)
[ -f "$(pvesm path %[3]s:vztmpl/$T 2>/dev/null)" ] || pveam download %[3]s "$T"
ID=$(pvesh get /cluster/nextid)
pct create "$ID" "%[3]s:vztmpl/$T" --hostname %[1]s --cores 1 --memory 512 --swap 512 \
  --rootfs %[4]s:4 --net0 name=eth0,bridge=%[5]s,ip=dhcp --unprivileged 1 --features nesting=1 \
  --dev0 /dev/net/tun --onboot 1 --tags mia --description "Gateway Tailscale criado pelo Mia" --start 1
echo "==> CT $ID criado, esperando a rede"
for i in $(seq 1 30); do pct exec "$ID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done
pct exec "$ID" -- bash -s <<'MIA_TS'
set -e
apt-get update -qq && apt-get install -y -qq curl >/dev/null
curl -fsSL https://tailscale.com/install.sh | sh
printf 'net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n' > /etc/sysctl.d/99-tailscale.conf
sysctl -p /etc/sysctl.d/99-tailscale.conf
tailscale up --auth-key=%[6]s --hostname=%[1]s --advertise-routes=%[2]s --accept-dns=false
MIA_TS
echo "==> Pronto. Aprove a rota %[2]s em https://login.tailscale.com/admin/machines"
MIA_GW
`, hostname, subnet, tmpl, rootfs, bridge, key), nil
}

// --- atualização do Mia ---

const releasesAPI = "https://api.github.com/repos/LucasUltremare/nomade-server/releases/latest"

type updater struct {
	mu      sync.Mutex
	at      time.Time
	latest  string
	url     string
	current string
	reqPath string // arquivo que o mia-update.path (systemd, root) observa
}

func newUpdater(version, dataDir string) *updater {
	return &updater{current: version, reqPath: filepath.Join(dataDir, "update-request")}
}

func (u *updater) check(ctx context.Context) (latest, link string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if time.Since(u.at) < 6*time.Hour {
		return u.latest, u.url
	}
	u.at = time.Now()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, releasesAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return u.latest, u.url
	}
	defer res.Body.Close()
	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if res.StatusCode == http.StatusOK && json.NewDecoder(res.Body).Decode(&rel) == nil {
		u.latest, u.url = rel.TagName, rel.HTMLURL
	}
	return u.latest, u.url
}

// newer compara "v1.2.3" de forma simples; "dev" nunca pede atualização.
func newer(latest, current string) bool {
	if latest == "" || current == "" || current == "dev" {
		return false
	}
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.SplitN(v, "-", 2)[0], "v")
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		return out
	}
	l, c := parse(latest), parse(current)
	for i := 0; i < max(len(l), len(c)); i++ {
		var x, y int
		if i < len(l) {
			x = l[i]
		}
		if i < len(c) {
			y = c[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func (s *Server) handleUpdateInfo(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	latest, link := s.updater.check(r.Context())
	_, err := os.Stat("/etc/systemd/system/mia-update.path")
	writeJSON(w, map[string]any{
		"current":    s.cfg.Version,
		"latest":     latest,
		"url":        link,
		"available":  newer(latest, s.cfg.Version),
		"selfUpdate": err == nil && isRoot(a),
	})
}

func (s *Server) handleUpdateRun(w http.ResponseWriter, r *http.Request, a pve.Auth) {
	if !requireRoot(w, a) {
		return
	}
	if _, err := os.Stat("/etc/systemd/system/mia-update.path"); err != nil {
		writeErr(w, http.StatusPreconditionFailed, "atualização pelo painel não está instalada; rode o instalador de novo")
		return
	}
	if err := os.WriteFile(s.updater.reqPath, []byte(time.Now().Format(time.RFC3339)+"\n"), 0o640); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

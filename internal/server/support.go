package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// cache guarda respostas agregadas por usuário (as permissões do PVE fazem
// cada um ver uma coisa) por alguns segundos, pra o polling do front não
// martelar a API.
type cache struct {
	mu sync.Mutex
	m  map[string]cacheEntry
}

type cacheEntry struct {
	at time.Time
	v  any
}

func newCache() *cache { return &cache{m: map[string]cacheEntry{}} }

func cached[T any](c *cache, user, key string, ttl time.Duration, fn func() (T, error)) (T, error) {
	k := user + "|" + key
	c.mu.Lock()
	e, ok := c.m[k]
	c.mu.Unlock()
	if ok && time.Since(e.at) < ttl {
		return e.v.(T), nil
	}
	v, err := fn()
	if err != nil {
		return v, err
	}
	c.mu.Lock()
	c.m[k] = cacheEntry{at: time.Now(), v: v}
	c.mu.Unlock()
	return v, nil
}

func (c *cache) invalidate(user string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		if strings.HasPrefix(k, user+"|") {
			delete(c.m, k)
		}
	}
}

// state é o pouco que o Mia guarda em disco: favoritos por usuário e a
// auth key do Tailscale.
type state struct {
	mu   sync.Mutex
	path string
	data struct {
		Favorites    map[string][]string `json:"favorites"`
		TailscaleKey string              `json:"tailscaleKey,omitempty"`
	}
}

func loadState(dir string) (*state, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	s := &state{path: filepath.Join(dir, "state.json")}
	raw, err := os.ReadFile(s.path)
	if err == nil {
		json.Unmarshal(raw, &s.data)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if s.data.Favorites == nil {
		s.data.Favorites = map[string][]string{}
	}
	return s, nil
}

// favorites devolve nil se o usuário nunca escolheu (o front usa um padrão).
func (s *state) favorites(user string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.data.Favorites[user])
}

func (s *state) setFavorites(user string, ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ids == nil {
		ids = []string{}
	}
	s.data.Favorites[user] = slices.Compact(ids)
	return s.save()
}

func (s *state) tailscaleKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.TailscaleKey
}

func (s *state) setTailscaleKey(k string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.TailscaleKey = k
	return s.save()
}

// save grava o estado; chamar com s.mu travado.
func (s *state) save() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// tailscale lê o estado do tailscaled no host, se estiver instalado.
type tailscale struct {
	demo bool
	mu   sync.Mutex
	at   time.Time
	val  string
}

// status: "online", "offline" ou "" quando não há tailscale.
func (t *tailscale) status(ctx context.Context) string {
	if t.demo {
		return "online"
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if time.Since(t.at) < 30*time.Second {
		return t.val
	}
	t.at = time.Now()
	t.val = ""
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "status", "--json", "--peers=false").Output()
	if err != nil {
		t.val = "offline"
		return t.val
	}
	var st struct{ BackendState string }
	json.Unmarshal(out, &st)
	if st.BackendState == "Running" {
		t.val = "online"
	} else {
		t.val = "offline"
	}
	return t.val
}

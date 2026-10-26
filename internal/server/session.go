package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/LucasUltremare/nomade-server/internal/pve"
)

const (
	cookieName = "mia_session"
	// Os tickets do PVE valem 2h; renova com folga.
	renewAfter = 45 * time.Minute
	// Sessão sem uso por mais que isso é descartada.
	idleTimeout = 12 * time.Hour
	// Tempo pra completar o segundo fator.
	tfaTimeout = 5 * time.Minute
)

type session struct {
	id string

	mu       sync.Mutex
	auth     pve.Auth
	renewed  time.Time
	lastSeen time.Time
	// pendingTFA: login parado no segundo fator; auth.Ticket é o desafio.
	pendingTFA bool
}

type sessionStore struct {
	mu sync.Mutex
	m  map[string]*session
}

func newSessionStore() *sessionStore {
	s := &sessionStore{m: map[string]*session{}}
	go s.janitor()
	return s
}

func (s *sessionStore) janitor() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now()
		s.mu.Lock()
		for id, sess := range s.m {
			sess.mu.Lock()
			dead := now.Sub(sess.lastSeen) > idleTimeout ||
				(sess.pendingTFA && now.Sub(sess.renewed) > tfaTimeout)
			sess.mu.Unlock()
			if dead {
				delete(s.m, id)
			}
		}
		s.mu.Unlock()
	}
}

func (s *sessionStore) create(a pve.Auth, pendingTFA bool) *session {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	now := time.Now()
	sess := &session{id: hex.EncodeToString(buf), auth: a, renewed: now, lastSeen: now, pendingTFA: pendingTFA}
	s.mu.Lock()
	s.m[sess.id] = sess
	s.mu.Unlock()
	return sess
}

func (s *sessionStore) get(r *http.Request) *session {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[c.Value]
}

func (s *sessionStore) drop(id string) {
	s.mu.Lock()
	delete(s.m, id)
	s.mu.Unlock()
}

// current devolve o ticket da sessão, renovando no PVE quando estiver velho.
func (sess *session) current(ctx context.Context, c *pve.Client) (pve.Auth, error) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.lastSeen = time.Now()
	if time.Since(sess.renewed) < renewAfter {
		return sess.auth, nil
	}
	a, err := c.Renew(ctx, sess.auth)
	if err != nil {
		return pve.Auth{}, err
	}
	sess.auth, sess.renewed = a, time.Now()
	return a, nil
}

func setSessionCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
}

// limiter conta falhas de login por IP numa janela curta.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *limiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-time.Minute)
	recent := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if t.After(cut) {
			recent = append(recent, t)
		}
	}
	l.hits[ip] = recent
	return len(recent) >= 5
}

func (l *limiter) fail(ip string) {
	l.mu.Lock()
	l.hits[ip] = append(l.hits[ip], time.Now())
	l.mu.Unlock()
}

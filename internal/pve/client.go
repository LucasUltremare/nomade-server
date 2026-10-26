// Package pve é um cliente mínimo da API REST do Proxmox VE (/api2/json).
//
// O Mia não guarda credenciais próprias: cada usuário faz login com a conta
// do Proxmox e as chamadas usam o ticket dele, então as permissões do PVE
// valem como estão.
package pve

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Auth é o ticket de um usuário logado.
type Auth struct {
	User   string
	Ticket string
	CSRF   string
}

// Error é uma resposta não-2xx da API.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return fmt.Sprintf("pve: %d %s", e.Status, e.Msg) }

// IsAuth diz se o erro é de ticket inválido/expirado.
func IsAuth(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusUnauthorized
}

type Client struct {
	base string // https://host:8006/api2/json
	http *http.Client
}

// New cria um cliente. Em loopback a verificação TLS é desligada (o pveproxy
// local pode estar com certificado ACME de outro domínio); fora disso usa as
// raízes do sistema mais a CA do cluster, se existir.
func New(rawURL string) (*Client, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	tlsCfg := &tls.Config{}
	if isLoopback(u.Hostname()) {
		tlsCfg.InsecureSkipVerify = true
	} else {
		pool, _ := x509.SystemCertPool()
		if pool == nil {
			pool = x509.NewCertPool()
		}
		if pem, err := os.ReadFile("/etc/pve/pve-root-ca.pem"); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
		tlsCfg.RootCAs = pool
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = tlsCfg
	tr.MaxIdleConnsPerHost = 32
	return &Client{
		base: strings.TrimRight(u.String(), "/") + "/api2/json",
		http: &http.Client{Transport: tr, Timeout: 30 * time.Second},
	}, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (c *Client) do(ctx context.Context, a *Auth, method, path string, form url.Values, out any) error {
	var body io.Reader
	target := c.base + path
	if method == http.MethodGet || method == http.MethodDelete {
		if len(form) > 0 {
			target += "?" + form.Encode()
		}
	} else if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if a != nil {
		req.AddCookie(&http.Cookie{Name: "PVEAuthCookie", Value: a.Ticket})
		if method != http.MethodGet {
			req.Header.Set("CSRFPreventionToken", a.CSRF)
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode/100 != 2 {
		msg := res.Status
		var env struct {
			Message string            `json:"message"`
			Errors  map[string]string `json:"errors"`
		}
		if json.Unmarshal(raw, &env) == nil {
			if env.Message != "" {
				msg = strings.TrimSpace(env.Message)
			}
			for k, v := range env.Errors {
				msg += fmt.Sprintf(" (%s: %s)", k, strings.TrimSpace(v))
			}
		}
		// O pveproxy devolve 401 com o motivo no status line.
		if i := strings.IndexByte(msg, ' '); res.StatusCode == 401 && i > 0 && env.Message == "" {
			msg = msg[i+1:]
		}
		return &Error{Status: res.StatusCode, Msg: msg}
	}
	if out == nil {
		return nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("pve: resposta inválida em %s: %w", path, err)
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

func (c *Client) Get(ctx context.Context, a *Auth, path string, q url.Values, out any) error {
	return c.do(ctx, a, http.MethodGet, path, q, out)
}

func (c *Client) Post(ctx context.Context, a *Auth, path string, form url.Values, out any) error {
	if form == nil {
		form = url.Values{}
	}
	return c.do(ctx, a, http.MethodPost, path, form, out)
}

// LoginResult é o retorno de Login. Com NeedTFA o ticket é só um desafio e
// precisa ser completado com CompleteTFA.
type LoginResult struct {
	Auth    Auth
	NeedTFA bool
}

type ticketResp struct {
	Username string `json:"username"`
	Ticket   string `json:"ticket"`
	CSRF     string `json:"CSRFPreventionToken"`
	NeedTFA  Bool   `json:"NeedTFA"`
}

func (c *Client) Login(ctx context.Context, username, password string) (*LoginResult, error) {
	var r ticketResp
	err := c.Post(ctx, nil, "/access/ticket", url.Values{
		"username":   {username},
		"password":   {password},
		"new-format": {"1"},
	}, &r)
	if err != nil {
		return nil, err
	}
	return &LoginResult{
		Auth:    Auth{User: r.Username, Ticket: r.Ticket, CSRF: r.CSRF},
		NeedTFA: bool(r.NeedTFA),
	}, nil
}

// CompleteTFA responde ao desafio de segundo fator. response no formato do
// PVE: "totp:123456", "recovery:xxxx" etc.
func (c *Client) CompleteTFA(ctx context.Context, username, challenge, response string) (Auth, error) {
	var r ticketResp
	err := c.Post(ctx, nil, "/access/ticket", url.Values{
		"username":      {username},
		"tfa-challenge": {challenge},
		"password":      {response},
		"new-format":    {"1"},
	}, &r)
	if err != nil {
		return Auth{}, err
	}
	return Auth{User: r.Username, Ticket: r.Ticket, CSRF: r.CSRF}, nil
}

// Renew troca um ticket válido por um novo (os tickets duram 2h).
func (c *Client) Renew(ctx context.Context, a Auth) (Auth, error) {
	var r ticketResp
	err := c.Post(ctx, nil, "/access/ticket", url.Values{
		"username": {a.User},
		"password": {a.Ticket},
	}, &r)
	if err != nil {
		return Auth{}, err
	}
	return Auth{User: r.Username, Ticket: r.Ticket, CSRF: r.CSRF}, nil
}

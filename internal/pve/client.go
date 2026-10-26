// Package pve é um cliente mínimo da API REST do Proxmox VE (/api2/json).
//
// O Mia não guarda credenciais próprias: cada usuário faz login com a conta
// do Proxmox e as chamadas usam o ticket dele, então as permissões do PVE
// valem como estão.
package pve

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Auth é o ticket de um usuário logado ou um token de API ("user@realm!id=segredo").
type Auth struct {
	User   string
	Ticket string
	CSRF   string
	Token  string
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
	base    string // https://host:8006/api2/json
	http    *http.Client
	uploads *http.Client // sem timeout: ISO de vários GB demora
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
		base:    strings.TrimRight(u.String(), "/") + "/api2/json",
		http:    &http.Client{Transport: tr, Timeout: 30 * time.Second},
		uploads: &http.Client{Transport: tr},
	}, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// raw faz a requisição e devolve o corpo de uma resposta 2xx.
func (c *Client) raw(ctx context.Context, a *Auth, method, path string, form url.Values, body io.Reader, contentType string, size int64) ([]byte, error) {
	target := c.base + path
	if method == http.MethodGet || method == http.MethodDelete {
		if len(form) > 0 {
			target += "?" + form.Encode()
		}
	} else if body == nil && form != nil {
		enc := form.Encode()
		body, contentType, size = strings.NewReader(enc), "application/x-www-form-urlencoded", int64(len(enc))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", contentType)
		req.ContentLength = size
	}
	if a != nil && a.Token != "" {
		req.Header.Set("Authorization", "PVEAPIToken="+a.Token)
	} else if a != nil {
		req.AddCookie(&http.Cookie{Name: "PVEAuthCookie", Value: a.Ticket})
		if method != http.MethodGet {
			req.Header.Set("CSRFPreventionToken", a.CSRF)
		}
	}
	cl := c.http
	if strings.HasPrefix(contentType, "multipart/") {
		cl = c.uploads
	}
	res, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
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
		return nil, &Error{Status: res.StatusCode, Msg: msg}
	}
	return raw, nil
}

func (c *Client) do(ctx context.Context, a *Auth, method, path string, form url.Values, out any) error {
	raw, err := c.raw(ctx, a, method, path, form, nil, "", 0)
	if err != nil || out == nil {
		return err
	}
	return decodeData(raw, path, out)
}

func decodeData(raw []byte, path string, out any) error {
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

func (c *Client) Put(ctx context.Context, a *Auth, path string, form url.Values, out any) error {
	if form == nil {
		form = url.Values{}
	}
	return c.do(ctx, a, http.MethodPut, path, form, out)
}

func (c *Client) Delete(ctx context.Context, a *Auth, path string, q url.Values, out any) error {
	return c.do(ctx, a, http.MethodDelete, path, q, out)
}

// GetEnvelope é um Get que também devolve os campos fora de "data" (o
// /nodes/{node}/network, por exemplo, manda o diff pendente em "changes").
func (c *Client) GetEnvelope(ctx context.Context, a *Auth, path string, q url.Values, out any) (map[string]json.RawMessage, error) {
	raw, err := c.raw(ctx, a, http.MethodGet, path, q, nil, "", 0)
	if err != nil {
		return nil, err
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	return env, decodeData(raw, path, out)
}

// Upload manda um arquivo em multipart sem bufferizar: o pveproxy exige
// Content-Length, então o tamanho é calculado antes a partir de size.
func (c *Client) Upload(ctx context.Context, a *Auth, path string, fields map[string]string, filename string, file io.Reader, size int64) (string, error) {
	var head, tail bytes.Buffer
	mw := multipart.NewWriter(&head)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return "", err
		}
	}
	if _, err := mw.CreateFormFile("filename", filename); err != nil {
		return "", err
	}
	// O fechamento escreve o boundary final; separa ele num buffer próprio.
	tw := multipart.NewWriter(&tail)
	tw.SetBoundary(mw.Boundary())
	tail.WriteString("\r\n")
	tw.Close()
	body := io.MultiReader(&head, io.LimitReader(file, size), &tail)
	total := int64(head.Len()) + size + int64(tail.Len())
	raw, err := c.raw(ctx, a, http.MethodPost, path, nil, body, mw.FormDataContentType(), total)
	if err != nil {
		return "", err
	}
	var upid string
	return upid, decodeData(raw, path, &upid)
}

// Endpoint devolve a URL absoluta de um caminho da API (usado no proxy de websocket).
func (c *Client) Endpoint(path string) string { return c.base + path }

// Transport é o transporte HTTP do cliente, com a mesma config de TLS.
func (c *Client) Transport() http.RoundTripper { return c.http.Transport }

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

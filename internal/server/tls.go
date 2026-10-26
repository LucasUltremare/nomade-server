package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// certSource usa o mesmo certificado do pveproxy (o custom/ACME se houver,
// senão o do nó) pra o navegador confiar no Mia quando já confia no PVE. Sem
// acesso a eles, gera um autoassinado. Recarrega quando o arquivo muda
// (renovação ACME).
type certSource struct {
	certFile, keyFile string

	mu      sync.Mutex
	cert    *tls.Certificate
	mtime   time.Time
	checked time.Time
}

func newCertSource(cfg Config) (*certSource, error) {
	pairs := [][2]string{}
	if cfg.CertFile != "" {
		pairs = append(pairs, [2]string{cfg.CertFile, cfg.KeyFile})
	} else {
		pairs = append(pairs,
			[2]string{"/etc/pve/local/pveproxy-ssl.pem", "/etc/pve/local/pveproxy-ssl.key"},
			[2]string{"/etc/pve/local/pve-ssl.pem", "/etc/pve/local/pve-ssl.key"},
		)
	}
	for _, p := range pairs {
		if _, err := tls.LoadX509KeyPair(p[0], p[1]); err == nil {
			cs := &certSource{certFile: p[0], keyFile: p[1]}
			slog.Info("tls", "cert", p[0])
			return cs, cs.reload()
		}
	}
	if cfg.CertFile != "" {
		return nil, fmt.Errorf("não consegui ler %s / %s", cfg.CertFile, cfg.KeyFile)
	}
	crt := filepath.Join(cfg.DataDir, "tls.crt")
	key := filepath.Join(cfg.DataDir, "tls.key")
	if _, err := tls.LoadX509KeyPair(crt, key); err != nil {
		slog.Info("tls: gerando certificado autoassinado", "path", crt)
		if err := selfSigned(crt, key); err != nil {
			return nil, err
		}
	}
	cs := &certSource{certFile: crt, keyFile: key}
	return cs, cs.reload()
}

func (c *certSource) reload() error {
	st, err := os.Stat(c.certFile)
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		return err
	}
	c.cert, c.mtime = &cert, st.ModTime()
	return nil
}

func (c *certSource) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.checked) > time.Minute {
		c.checked = time.Now()
		if st, err := os.Stat(c.certFile); err == nil && !st.ModTime().Equal(c.mtime) {
			if err := c.reload(); err != nil {
				slog.Warn("tls: falha ao recarregar certificado", "err", err)
			}
		}
	}
	return c.cert, nil
}

func selfSigned(crtPath, keyPath string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: host, Organization: []string{"Mia"}},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{host, "localhost"},
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ipn.IP)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(crtPath), 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	return os.WriteFile(crtPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

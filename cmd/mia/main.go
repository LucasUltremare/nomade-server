// Mia: painel web pra gerenciar Proxmox VE, parte do projeto Nomade.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/LucasUltremare/nomade-server/internal/demo"
	"github.com/LucasUltremare/nomade-server/internal/server"
)

// Preenchido no build: -ldflags "-X main.version=v0.1.0".
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-v":
			fmt.Println(version)
			return
		case "serve":
			os.Args = append(os.Args[:1], os.Args[2:]...)
		}
	}

	cfg := server.Config{Version: version}
	flag.StringVar(&cfg.Listen, "listen", env("MIA_LISTEN", ":8443"), "endereço HTTPS")
	flag.StringVar(&cfg.PVEURL, "pve", env("MIA_PVE_URL", "https://127.0.0.1:8006"), "URL da API do Proxmox")
	flag.StringVar(&cfg.DataDir, "data", env("MIA_DATA_DIR", "/var/lib/mia"), "diretório de dados")
	flag.StringVar(&cfg.CertFile, "cert", env("MIA_TLS_CERT", ""), "certificado TLS (padrão: o do pveproxy)")
	flag.StringVar(&cfg.KeyFile, "key", env("MIA_TLS_KEY", ""), "chave TLS")
	flag.BoolVar(&cfg.Demo, "demo", env("MIA_DEMO", "") == "1", "sobe um Proxmox falso com dados de exemplo")
	flag.Parse()

	if cfg.Demo {
		d := demo.Start()
		defer d.Close()
		cfg.PVEURL = d.URL()
		if os.Getenv("MIA_DATA_DIR") == "" && !flagSet("data") {
			cfg.DataDir = ".mia-demo"
		}
	}

	srv, err := server.New(cfg)
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Run(ctx); err != nil {
		slog.Error("servidor", "err", err)
		os.Exit(1)
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func flagSet(name string) bool {
	set := false
	flag.Visit(func(f *flag.Flag) { set = set || f.Name == name })
	return set
}

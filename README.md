# Mia

Painel web pra gerenciar Proxmox VE, parte do projeto **Nomade**. Você roda um comando no shell do Proxmox e ganha uma aplicação web no mesmo host.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/LucasUltremare/nomade-server/main/install.sh)"
```

Depois é só abrir `https://<ip-do-host>:8443` e entrar com a mesma conta do Proxmox (`root@pam` ou qualquer usuário do PVE). Rodar o comando de novo abre o menu de **atualizar**, **mudar a porta** ou **desinstalar**.

## Como funciona

- **Um binário só** (Go, ~9 MB, frontend embutido) em `/usr/local/bin/mia`, rodando como serviço systemd `mia`. Não instala Node, Python nem banco de dados no host.
- **Sem credenciais próprias.** O login é feito na API do Proxmox (`/access/ticket`, com suporte a TOTP), e cada chamada usa o ticket do próprio usuário. Por isso as permissões do PVE valem como estão: quem só pode ver uma VM só vê essa VM.
- **Usuário sem privilégios.** O serviço roda como `mia` (no grupo `www-data` só pra ler o certificado do pveproxy), com o sandbox do systemd ligado (`ProtectSystem=strict` etc.).
- **HTTPS com o certificado do Proxmox.** O Mia usa o `pveproxy-ssl.pem` (ACME/custom) ou o `pve-ssl.pem` do nó. Se o navegador já confia no Proxmox, confia no Mia. Sem acesso a eles, gera um autoassinado em `/var/lib/mia`.
- Fala com a API em `https://127.0.0.1:8006`. Num cluster, basta instalar em um nó: o pveproxy encaminha as chamadas pros outros.

| Caminho | O que é |
|---|---|
| `/usr/local/bin/mia` | binário |
| `/etc/mia/mia.env` | configuração (porta, URL da API, certificado) |
| `/var/lib/mia` | favoritos de cada usuário, certificado gerado |
| `journalctl -u mia -f` | logs |

Instalação sem menu, pra automação: `MIA_YES=1 bash install.sh install`. Também aceita `update` e `uninstall`. Pra fixar uma versão: `MIA_VERSION=v0.1.0`; pra trocar a porta: `MIA_PORT=9443`.

## O que já tem

- **Visão geral**: carga média do cluster com comparativo do período anterior (24h, 7d, 30d), distribuição de CPU de todos os guests com destaque do pico, tendência de CPU e RAM com as janelas de backup (tirado das tasks de `vzdump`) e quais guests puxaram o pico.
- **Painel do nó**: CPU, load, memória, uptime, processador, IP, pool ZFS e guests. Atalho pro shell do nó no Proxmox.
- **Guests**: listas de VMs e LXCs com filtro; detalhe com iniciar, desligar, reiniciar e forçar parada (com confirmação); favoritos.
- **Backup do cluster** (`⌘B`): `vzdump` de todos os guests em cada nó, escolhendo storage e modo.
- **Busca** (`/` ou `⌘K`) por VM, LXC ou nó.
- Tema claro e escuro, layout de celular.

Ainda são placeholders: Armazenamento, Rede, Backups, Console, as abas Saúde/Backups/Firewall/Tarefas, migração de guests e notificações.

## Desenvolvimento

Precisa de Go 1.24+ e Node 20+.

```bash
npm --prefix web install
make demo        # build completo + Proxmox falso em https://127.0.0.1:8443
make dev         # backend demo + Vite com hot reload em http://localhost:5173
make test
```

O modo `--demo` sobe um Proxmox falso (`internal/demo`) com 3 nós, 16 guests e métricas sintéticas. Qualquer usuário e senha entram (menos a senha `errada`); um usuário que começa com `tfa` pede segundo fator, e o código é `123456`.

```
cmd/mia/            entrada (mia serve, mia version)
internal/pve/       cliente da API do Proxmox
internal/server/    API JSON do Mia, sessões, TLS, agregação das métricas
internal/demo/      Proxmox falso pra dev e testes
web/                frontend React + Vite (embutido no binário via web/embed.go)
install.sh          instalador one-liner
```

## Publicar uma versão

O instalador baixa sempre a última release do GitHub. Pra publicar:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

O workflow `.github/workflows/release.yml` compila o frontend, roda os testes e publica `mia_linux_amd64.tar.gz`, `mia_linux_arm64.tar.gz` e `checksums.txt`. O instalador confere o checksum antes de instalar.

## Licença

MIT. Veja [LICENSE](LICENSE).

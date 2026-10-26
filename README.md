# Mia

A web dashboard for Proxmox VE, part of the **Nomade** project. Run one command in the Proxmox shell and get a web app on the same host.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/LucasUltremare/nomade-server/main/install.sh)"
```

Then open `https://<host-ip>:8443` and sign in with your Proxmox account (`root@pam` or any PVE user). Running the command again opens a menu to **update**, **change the port** or **uninstall**.

## How it works

- **A single binary** (Go, ~9 MB, frontend embedded) at `/usr/local/bin/mia`, running as the `mia` systemd service. Nothing else gets installed on the host: no Node, no Python, no database.
- **No separate accounts.** Login goes through the Proxmox API (`/access/ticket`, TOTP supported) and every request uses that user's own ticket, so PVE permissions apply as they are: someone who can only see one VM only sees that VM.
- **Unprivileged service.** It runs as the `mia` user (in the `www-data` group only to read the pveproxy certificate), with systemd sandboxing on (`ProtectSystem=strict` and friends).
- **HTTPS with the Proxmox certificate.** Mia reuses the node's `pveproxy-ssl.pem` (ACME/custom) or `pve-ssl.pem`, so if your browser trusts Proxmox it trusts Mia. If it can't read them, it generates a self-signed one in `/var/lib/mia`.
- It talks to the API at `https://127.0.0.1:8006`. In a cluster, install it on one node: pveproxy forwards calls to the others.

| Path | What it is |
|---|---|
| `/usr/local/bin/mia` | binary |
| `/etc/mia/mia.env` | config (port, API URL, certificate) |
| `/var/lib/mia` | per-user favorites, generated certificate |
| `journalctl -u mia -f` | logs |

Unattended install: `MIA_YES=1 bash install.sh install` (also `update` and `uninstall`). Pin a version with `MIA_VERSION=v0.1.0`; change the port with `MIA_PORT=9443`.

## What's there

- **Overview**: average cluster load compared with the previous period (24h, 7d, 30d), CPU distribution across all guests with the peak highlighted, CPU and RAM trend with backup windows (taken from `vzdump` tasks) and which guests drove the peak.
- **Node panel**: CPU, load, memory, uptime, processor, IP, ZFS pool and guests, plus a shortcut to the node shell in Proxmox.
- **Guests**: VM and LXC lists with filtering; detail view with start, shutdown, reboot and force stop (with confirmation); favorites.
- **Cluster backup** (`⌘B`): `vzdump` of every guest on each node, picking storage and mode.
- **Search** (`/` or `⌘K`) across VMs, LXCs and nodes.
- Light and dark themes, mobile layout.

Still placeholders: Storage, Network, Backups, Console, the Health/Backups/Firewall/Tasks tabs, guest migration and notifications.

## Development

Requires Go 1.24+ and Node 20+.

```bash
npm --prefix web install
make demo        # full build + fake Proxmox at https://127.0.0.1:8443
make dev         # demo backend + Vite with hot reload at http://localhost:5173
make test
```

`--demo` starts a fake Proxmox (`internal/demo`) with 3 nodes, 16 guests and synthetic metrics. Any username and password work (except the password `errada`); a username starting with `tfa` asks for a second factor, and the code is `123456`.

```
cmd/mia/            entry point (mia serve, mia version)
internal/pve/       Proxmox API client
internal/server/    Mia's JSON API, sessions, TLS, metrics aggregation
internal/demo/      fake Proxmox for development and tests
web/                React + Vite frontend (embedded in the binary via web/embed.go)
install.sh          one-line installer
```

## Releasing

The installer always fetches the latest GitHub release. To publish one:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The `.github/workflows/release.yml` workflow builds the frontend, runs the tests and publishes `mia_linux_amd64.tar.gz`, `mia_linux_arm64.tar.gz` and `checksums.txt`. The installer verifies the checksum before installing.

## License

MIT. See [LICENSE](LICENSE).

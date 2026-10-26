<p align="center"><img src="docs/logo.svg" width="120" alt="Mia"></p>

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
| `/var/lib/mia` | per-user favorites, Tailscale auth key, app catalog cache, generated certificate |
| `journalctl -u mia -f` | logs |

Unattended install: `MIA_YES=1 bash install.sh install` (also `update` and `uninstall`). Pin a version with `MIA_VERSION=v0.1.0`; change the port with `MIA_PORT=9443`.

## What's there

- **Overview**: average cluster load compared with the previous period (24h, 7d, 30d), CPU distribution across all guests with the peak highlighted, CPU and RAM trend with backup windows (taken from `vzdump` tasks) and which guests drove the peak.
- **Node panel**: CPU, load, memory, uptime, processor, IP, ZFS pool and guests, plus the node shell.
- **Console**: node shell and LXC consoles (xterm.js over Proxmox's own `termproxy`) and VM screens (noVNC over `vncproxy`), all in the browser, proxied by Mia with the user's ticket.
- **Apps**: the [Proxmox VE Helper-Scripts](https://community-scripts.org) catalog (~700 apps), with search and categories. Installing runs the script in the node console so you watch it live and can answer its prompts. CPU, RAM and disk come pre-filled from the script's defaults.
- **New LXC**: template (downloaded on the fly if needed), resources, storage, bridge, VLAN, DHCP or static IP, password or SSH key, nesting and `/dev/net/tun`, with the task log streamed live.
- **Guests**: VM and LXC lists; detail view with start, shutdown, reboot and force stop (with confirmation), console, clone, convert to template (and create from template), delete (typing the name to confirm), favorites, and tabs for:
  - **Charts**: CPU, memory, network and disk over 1h, 24h, 7d or 30d;
  - **Hardware**: CPU, RAM and swap; disks and mount points (grow, add, move to another storage, detach, delete unused); the VM's CD/DVD ISO;
  - **Snapshots**: take (with RAM for running VMs), roll back, delete;
  - **Firewall**: the guest's own rules.
- **New VM**: from an ISO, with presets for Linux, Windows 11 (UEFI, TPM 2.0, Secure Boot), Windows 10 and others.
- **Migration**: move one guest or several from a node to another (VMs live; LXCs restart on the target).
- **Health**: one list of what needs attention (SMART failures and SSD wear, degraded ZFS pools, stopped PVE services, pending updates, certificates about to expire, storage filling up, nodes offline, guests with no backup job), plus disk, service, update and certificate details. Updates can be run in the node console.
- **Backups**: scheduled jobs (create, edit, enable/disable, run now, retention) and, per guest, the last backup found and whether a job covers it.
- **Firewall**: datacenter, node and guest levels; rules with ready-made services (SSH, HTTP...), and a warning plus one-click rule if enabling the datacenter firewall would lock you out of Mia's port.
- **Tasks**: everything that ran or is running in the cluster, with logs and stop.
- **Notifications**: the bell shows health issues and tasks that failed in the last 24h.
- **Network**: interfaces per node, new bridges and VLANs, pending-changes diff with apply/revert, current traffic.
- **VPN · Tailscale**: save an auth key once, then
  - **gateway**: one click creates a small Debian LXC running Tailscale as a subnet router for the bridge's network, so everything on the LAN (including what you add later) is reachable over the VPN;
  - **per-app address**: from the app store (tick *Publish on Tailscale*) or any running LXC (*Expose on Tailscale*), Mia installs Tailscale inside the container and publishes the app with `tailscale serve` at `https://<name>.<tailnet>.ts.net`.
- **Storage**: every storage with usage; ISOs, templates, backups and disks; upload with progress, download from URL, delete, and restore a backup into a new guest.
- **Cluster backup** (`⌘B`), **search** (`/` or `⌘K`), light and dark themes, mobile layout.
- **Updates**: Mia checks GitHub for a newer release and shows it in the sidebar. `root@pam` can update with one click (a systemd path unit runs the installer as root; Mia itself stays unprivileged).

Things that run as root on the node (app installs, Tailscale) go through the node console, so they need `root@pam` and you can read every command before and while it runs.

## Development

Requires Go 1.24+ and Node 20+.

```bash
npm --prefix web install
make demo        # full build + fake Proxmox at https://127.0.0.1:8443
make dev         # demo backend + Vite with hot reload at http://localhost:5173
make test
```

`--demo` starts a fake Proxmox (`internal/demo`) with 3 nodes, 16 guests and synthetic metrics, plus a fake shell, networks, storages and tasks, so every screen works locally (the app catalog is the real one). Any username and password work (except the password `errada`); a username starting with `tfa` asks for a second factor, and the code is `123456`.

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

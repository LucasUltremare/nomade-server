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
| `/etc/mia/mia.env` | config (port, API URL, certificate, API token for scheduled jobs) |
| `/var/lib/mia` | per-user favorites, Tailscale auth key, scheduled jobs, app catalog cache, generated certificate |
| `journalctl -u mia -f` | logs |

Scheduled jobs run while nobody is logged in, so the installer creates a `mia@pve` user with a limited `MiaJobs` role and an API token for them. Uninstalling removes both.

Unattended install: `MIA_YES=1 bash install.sh install` (also `update` and `uninstall`). Pin a version with `MIA_VERSION=v0.1.0`; change the port with `MIA_PORT=9443`.

## What's there

Everything the Proxmox web UI does (see [docs/ROADMAP.md](docs/ROADMAP.md) for the exact parity list and the few gaps), plus extras. In short:

- **My apps**: your self-hosted apps as a home page, with icons, status and local + Tailscale links. **Update all** updates every LXC (or every community-scripts app) in one console run.
- **Overview**: cluster load compared with the previous period, CPU distribution across guests, CPU and RAM trend with backup windows and which guests drove the peak.
- **Nodes**: summary, charts, updates (the PVE upgrade terminal), repositories (one click to no-subscription), disks (SMART, wipe, GPT, create ZFS / LVM / LVM-thin / directory), DNS, hosts, time zone, Wake-on-LAN, notes, certificates (custom and ACME), syslog, subscription, bulk start/stop.
- **Guests** (VM and LXC): power actions incl. suspend, hibernate and reset; console (xterm.js or noVNC); charts; full hardware (CPU type, balloon, BIOS, machine, display, disks and mount points, NICs, USB, PCI, serial, device passthrough); network and DNS; options; snapshots; backups and restore; task history; firewall; clone, template, migrate, delete. VMs also get **Cloud-Init** and the **QEMU monitor**.
- **New VM / LXC**: VM from an ISO (presets incl. Windows 11 with UEFI and TPM), **VM from a cloud image** (Debian/Ubuntu, ready in a minute with user, SSH key and network via Cloud-Init), **import OVA or ESXi VMs**, LXC from a template downloaded on the fly.
- **Apps**: the [Proxmox VE Helper-Scripts](https://community-scripts.org) catalog (~700 apps). Installing runs the script in the node console so you watch it live and can answer its prompts. **Stacks** install a whole kit in one go (media, smart home, network, photos and documents, dev) with a shared folder between the apps and optional Tailscale addresses.
- **Storage**: every storage with usage and content; upload with progress, download from URL, restore. **Shared folders**: one host folder mounted in several LXCs, with the unprivileged ID mapping handled for you.
- **Easy GPU**: one button passes the node's iGPU (`/dev/dri`) to an LXC for Jellyfin or Plex transcoding.
- **Datacenter**: options and notes, cluster create/join, storages (dir, NFS, SMB, PBS, ZFS, LVM, BTRFS, ESXi), users, groups, API tokens, two-factor (TOTP and recovery keys), roles, permissions, realms, pools, HA, replication, SDN, firewall groups / aliases / IPSets, notifications, ACME, device mappings, metric servers, Ceph (install, init, monitors, managers, OSDs, pools, CephFS), cluster log.
- **Scheduled jobs**: turn guests on and off on a schedule, take **automatic snapshots** with retention, and run an **automatic restore test** that restores the latest backup into a throwaway guest, boots it, checks it and deletes it.
- **Health**: one list of what needs attention (SMART and SSD wear, degraded ZFS, stopped services, pending updates, expiring certificates, storage filling up, nodes offline, guests with no backup), plus a notifications bell.
- **Backups, firewall, tasks, network** (bridges, VLANs, pending diff with apply/revert), with a guard that warns before the datacenter firewall locks you out of Mia.
- **VPN · Tailscale**: a one-click gateway LXC that routes your LAN, and per-app HTTPS addresses at `https://<name>.<tailnet>.ts.net`.
- **Search** (`/` or `⌘K`), cluster backup (`⌘B`), light and dark themes, mobile layout, and one-click self-update.

Things that run as root on the node (app installs, stacks, shared folders, GPU, Tailscale) go through the node console, so they need `root@pam` and you can read every command before and while it runs.

## Development

Requires Go 1.24+ and Node 20+.

```bash
npm --prefix web install
make demo        # full build + fake Proxmox at https://127.0.0.1:8443
make dev         # demo backend + Vite with hot reload at http://localhost:5173
make test
```

`--demo` starts a fake Proxmox (`internal/demo`) with 3 nodes, 16 guests and synthetic metrics, plus a fake shell, networks, storages and tasks, so every screen works locally (the app catalog is the real one). Any username and password work (except the password `errada`); a username starting with `tfa` asks for a second factor, and the code is `123456`. Set `MIA_DEMO_CEPH=1` to get a healthy Ceph cluster in the demo.

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

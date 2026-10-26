# Roadmap

Goal: everything the Proxmox VE web UI does, plus Mia-only extras on top.

✅ done · 🟡 partial · ⬜ missing

## Parity with the Proxmox UI

### Datacenter

| Area | Status | Notes |
|---|---|---|
| Summary | ✅ | Overview: load, distribution, trend, backup windows |
| Search | ✅ | `/` or `⌘K` |
| Notes | ⬜ | |
| Cluster (create, join, join info) | ⬜ | |
| Options (keyboard, proxy, email, MAC prefix, migration network, ID range, tags) | ⬜ | |
| Storage definitions (add/edit/remove dir, NFS, SMB, PBS, ZFS, LVM, LVM-thin, iSCSI, BTRFS, Ceph) | ⬜ | Mia lists storages and their content, can't add new ones |
| Backup jobs | ✅ | Schedule, selection, retention, run now |
| Replication (ZFS) | ⬜ | |
| Users, groups, API tokens | ⬜ | |
| Two-factor (TOTP, WebAuthn, recovery) | 🟡 | Login with TOTP works; can't manage factors |
| Roles, permissions, realms (PAM, PVE, LDAP, AD, OpenID) | ⬜ | |
| Resource pools | ⬜ | |
| HA (status, resources, affinity rules) | ⬜ | |
| SDN (zones, VNets, subnets, IPAM, fabrics) | ⬜ | |
| ACME (accounts, DNS plugins) | ⬜ | |
| Firewall: options, rules | ✅ | With Mia lockout warning |
| Firewall: security groups, aliases, IPSets, log | ⬜ | |
| Metric servers (InfluxDB, Graphite) | ⬜ | |
| Resource mappings (PCI, USB, directories) | ⬜ | |
| Notifications (SMTP, Gotify, webhook targets; matchers) | ⬜ | |
| Ceph | ⬜ | |
| Subscription | ⬜ | |
| Tasks | ✅ | Cluster-wide, log, stop |
| Cluster log | ⬜ | |

### Node

| Area | Status | Notes |
|---|---|---|
| Summary | 🟡 | Panel with CPU, memory, uptime, CPU model, pool; no per-node charts |
| Notes | ⬜ | |
| Shell | ✅ | xterm.js |
| Network | ✅ | Bridges, VLANs, pending diff, apply/revert; bonds and editing existing interfaces missing |
| Certificates | 🟡 | Expiry shown in Health; no upload or ACME order |
| DNS, hosts, time zone | ⬜ | |
| Syslog | ⬜ | |
| Updates | 🟡 | List + run in console; no refresh-and-upgrade UI |
| Repositories (enterprise / no-subscription / test) | ⬜ | |
| Firewall | ✅ | |
| Disks: list, SMART | 🟡 | Health status and wearout; no full SMART attributes |
| Disks: wipe, initialize GPT, create LVM / LVM-thin / directory / ZFS | ⬜ | |
| Ceph | ⬜ | |
| Replication | ⬜ | |
| Task history | ✅ | Via cluster tasks |
| Bulk start / stop / migrate | 🟡 | Bulk migrate only |
| Wake-on-LAN | ⬜ | |

### VM

| Area | Status | Notes |
|---|---|---|
| Create (ISO) | ✅ | Presets Linux, Windows 11/10, other |
| Summary, charts | ✅ | |
| Console (noVNC) | ✅ | |
| Start, shutdown, reboot, stop | ✅ | |
| Suspend, hibernate, reset, resume | 🟡 | Resume only |
| Hardware: CPU count, memory, disks, CD | ✅ | Grow, add, move, detach, delete |
| Hardware: CPU type, balloon, BIOS, machine, display, NICs, USB, PCI, serial, EFI/TPM | ⬜ | |
| Disk options (cache, discard, IO thread, backup flag) | ⬜ | |
| Cloud-Init | ⬜ | |
| Options (name, start at boot, boot order, OS type, agent, protection, hotplug, startup order) | ⬜ | |
| Snapshots | ✅ | Incl. RAM |
| Backup now / backups of this guest / restore over | 🟡 | Restore to a new guest via Storage |
| Replication | ⬜ | |
| Firewall | ✅ | |
| Permissions | ⬜ | |
| Migrate, clone, template, delete | ✅ | |
| Import (OVA, ESXi) | ⬜ | |

### LXC

| Area | Status | Notes |
|---|---|---|
| Create | ✅ | Template download on the fly |
| Summary, charts, console | ✅ | |
| Resources: cores, memory, swap, disks, mount points | ✅ | |
| CPU limit / units | ⬜ | |
| Network (add/edit NICs, IP, VLAN, firewall flag) | ⬜ | |
| DNS | ⬜ | |
| Options (start at boot, startup order, features: nesting/keyctl/fuse/NFS/CIFS, protection, console mode) | ⬜ | |
| Snapshots, firewall, migrate, clone, template, delete | ✅ | |
| Backup now / backups of this guest | 🟡 | |
| Replication, permissions | ⬜ | |

### Storage

| Area | Status | Notes |
|---|---|---|
| Summary, content (ISO, templates, backups, disks) | ✅ | |
| Upload, download from URL, delete | ✅ | |
| Restore backup | ✅ | Into a new guest |
| Import content (OVA) | ⬜ | |

## Mia-only extras

| Feature | Status |
|---|---|
| App store (community-scripts), live install in console | ✅ |
| Tailscale: gateway, per-app HTTPS address | ✅ |
| Health checks + notifications bell | ✅ |
| Firewall lockout guard | ✅ |
| One-click self-update | ✅ |
| "My apps" homepage (icons, status, local + Tailscale links) | ⬜ |
| Shared folders between LXCs (bind mounts with unprivileged ID mapping) | ⬜ |
| Easy GPU / USB passthrough (iGPU to Jellyfin, Zigbee to Home Assistant) | ⬜ |
| Nomade stacks (e.g. media kit in one click) | ⬜ |
| Update all LXCs / community-scripts apps | ⬜ |
| Scheduled actions (power on/off) | ⬜ |
| Automatic snapshots with retention | ⬜ |
| Automatic restore test of backups | ⬜ |
| Disk-full forecast, energy cost | ⬜ |
| Cloudflare Tunnel publishing | ⬜ |
| Clean-up assistant (orphan disks, old ISOs/backups) | ⬜ |
| PWA / TV mode | ⬜ |

## Phases

1. **Guest details** (v0.5.0): guest network and options, full VM hardware, LXC device passthrough, missing power actions, bulk start/stop, per-guest backups and tasks, repositories, upgrades in the UI. Extras: **My apps** homepage, **Update all**.
2. **System and storage** (v0.6.0): disks (wipe, GPT, ZFS/LVM/dir), storage definitions, node DNS/hosts/time/syslog/WoL/notes/charts, certificates and ACME, notifications, resource mappings. Extras: **shared folders**, **easy GPU/USB**, **Nomade stacks**.
3. **Datacenter** (v0.7.0): users, groups, tokens, 2FA, realms, roles, permissions, pools; HA; replication; cluster create/join; datacenter options; firewall groups/aliases/IPSets/log; metric servers; Cloud-Init; OVA/ESXi import. Extras: Mia's own API token for background jobs, **automatic restore test**, scheduled actions, automatic snapshots.
4. **Advanced**: SDN, Ceph, QEMU monitor, subscription.

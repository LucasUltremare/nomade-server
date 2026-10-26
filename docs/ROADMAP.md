# Roadmap

Goal: everything the Proxmox VE web UI does, plus Mia-only extras on top.

✅ done · 🟡 partial · ⬜ missing

## Parity with the Proxmox UI

### Datacenter

| Area | Status | Notes |
|---|---|---|
| Summary | ✅ | Overview: load, distribution, trend, backup windows |
| Search | ✅ | `/` or `⌘K` |
| Notes | ✅ | |
| Cluster (create, join, join info) | ✅ | |
| Options (keyboard, proxy, email, MAC prefix, migration network, ID range, tags) | ✅ | |
| Storage definitions | 🟡 | dir, NFS, SMB, PBS, ZFS, LVM, LVM-thin, BTRFS, ESXi; iSCSI and external Ceph/RBD missing |
| Backup jobs | ✅ | Schedule, selection, retention, run now |
| Replication (ZFS) | ✅ | Jobs, status, run now |
| Users, groups, API tokens | ✅ | |
| Two-factor | 🟡 | TOTP (QR code) and recovery keys; WebAuthn and Yubico missing |
| Roles, permissions, realms (PAM, PVE, LDAP, AD, OpenID) | ✅ | Realm sync included |
| Resource pools | ✅ | |
| HA (status, resources, groups, rules) | ✅ | |
| SDN (zones, VNets, subnets, apply) | 🟡 | Fabrics and IPAM management missing |
| ACME (accounts, DNS plugins) | ✅ | |
| Firewall: options, rules | ✅ | With Mia lockout warning |
| Firewall: security groups, aliases, IPSets, log | ✅ | |
| Metric servers (InfluxDB, Graphite) | ✅ | |
| Resource mappings (PCI, USB, directories) | ✅ | |
| Notifications (sendmail, SMTP, Gotify, webhook targets; matchers) | ✅ | |
| Ceph | 🟡 | Install, init, status, OSD, monitor, manager, pools, CephFS; no CRUSH editing |
| Subscription | ✅ | View, upload key, check |
| Tasks | ✅ | Cluster-wide, log, stop |
| Cluster log | ✅ | |

### Node

| Area | Status | Notes |
|---|---|---|
| Summary, charts | ✅ | CPU, memory, load, network |
| Notes | ✅ | |
| Shell | ✅ | xterm.js |
| Network | ✅ | Bridges, VLANs, pending diff, apply/revert; bonds and editing existing interfaces missing |
| Certificates | ✅ | Custom upload, ACME order and renew |
| DNS, hosts, time zone | ✅ | |
| Syslog | ✅ | journal + firewall log |
| Updates | ✅ | Refresh, pending list, upgrade in the PVE upgrade terminal |
| Repositories (enterprise / no-subscription / test) | ✅ | Switches + one-click move to no-subscription |
| Firewall | ✅ | |
| Disks: list, SMART | ✅ | |
| Disks: wipe, initialize GPT, create LVM / LVM-thin / directory / ZFS | ✅ | |
| Ceph | 🟡 | See datacenter |
| Replication | ✅ | In datacenter |
| Task history | ✅ | Cluster-wide and per guest |
| Bulk start / stop / migrate | ✅ | |
| Wake-on-LAN | ✅ | |

### VM

| Area | Status | Notes |
|---|---|---|
| Create (ISO) | ✅ | Presets Linux, Windows 11/10, other |
| Create from cloud image | ✅ | Mia extra: Debian/Ubuntu cloud images with Cloud-Init |
| Summary, charts | ✅ | |
| Console (noVNC) | ✅ | |
| Start, shutdown, reboot, stop | ✅ | |
| Suspend, hibernate, reset, resume | ✅ | |
| Hardware: CPU count, memory, disks, CD | ✅ | Grow, add, move, detach, delete |
| Hardware: CPU type, balloon, BIOS, machine, display, NICs, USB, PCI, serial | ✅ | Adding EFI/TPM to an existing VM still missing |
| Disk options (cache, discard, IO thread, SSD, backup flag) | ✅ | |
| Cloud-Init | ✅ | User, password, SSH keys, network, regenerate |
| QEMU monitor | ✅ | |
| Options (name, start at boot, boot order, OS type, agent, protection, startup order, notes) | ✅ | |
| Snapshots | ✅ | Incl. RAM |
| Backup now / backups of this guest / restore over | ✅ | |
| Replication | ✅ | In datacenter |
| Firewall | ✅ | |
| Permissions | 🟡 | Set in datacenter → permissions (path `/vms/ID`); no per-guest tab |
| Migrate, clone, template, delete | ✅ | |
| Import (OVA, ESXi) | ✅ | From an import storage or an ESXi storage |

### LXC

| Area | Status | Notes |
|---|---|---|
| Create | ✅ | Template download on the fly |
| Summary, charts, console | ✅ | |
| Resources: cores, memory, swap, disks, mount points | ✅ | |
| CPU limit / units | ✅ | |
| Network (add/edit NICs, IP, VLAN, firewall flag, rate, MTU) | ✅ | |
| DNS | ✅ | |
| Options (start at boot, startup order, features: nesting/keyctl/fuse/NFS/CIFS, protection, notes) | ✅ | |
| Snapshots, firewall, migrate, clone, template, delete | ✅ | |
| Backup now / backups of this guest, task history, device passthrough | ✅ | |
| Replication, permissions | 🟡 | Replication in datacenter; permissions via datacenter |

### Storage

| Area | Status | Notes |
|---|---|---|
| Summary, content (ISO, templates, backups, disks) | ✅ | |
| Upload, download from URL, delete | ✅ | |
| Restore backup | ✅ | Into a new guest |
| Import content (OVA) | ✅ | |

## Mia-only extras

| Feature | Status |
|---|---|
| App store (community-scripts), live install in console | ✅ |
| Tailscale: gateway, per-app HTTPS address | ✅ |
| Health checks + notifications bell | ✅ |
| Firewall lockout guard | ✅ |
| One-click self-update | ✅ |
| "My apps" homepage (icons, status, local + Tailscale links) | ✅ |
| Shared folders between LXCs (bind mounts with unprivileged ID mapping) | ✅ |
| Easy GPU passthrough (iGPU to Jellyfin/Plex in one click) | ✅ |
| Nomade stacks (media, smart home, network, photos, dev kits) | ✅ |
| VM from cloud image in one form | ✅ |
| Update all LXCs / community-scripts apps | ✅ |
| Scheduled actions (power on/off) | ✅ |
| Automatic snapshots with retention | ✅ |
| Automatic restore test of backups | ✅ |
| Disk-full forecast, energy cost | ⬜ |
| Cloudflare Tunnel publishing | ⬜ |
| Clean-up assistant (orphan disks, old ISOs/backups) | ⬜ |
| PWA / TV mode | ⬜ |

## Phases

1. **Guest details**: guest network and options, full VM hardware, LXC device passthrough, missing power actions, bulk start/stop, per-guest backups and tasks, repositories, upgrades in the UI. Extras: **My apps** homepage, **Update all**. ✅
2. **System and storage**: disks (wipe, GPT, ZFS/LVM/dir), storage definitions, node DNS/hosts/time/syslog/WoL/notes/charts, certificates and ACME, notifications, resource mappings. Extras: **shared folders**, **easy GPU**, **Nomade stacks**. ✅
3. **Datacenter**: users, groups, tokens, 2FA, realms, roles, permissions, pools; HA; replication; cluster create/join; datacenter options; firewall groups/aliases/IPSets/log; metric servers; Cloud-Init; OVA/ESXi import. Extras: Mia's own API token for background jobs, **automatic restore test**, scheduled actions, automatic snapshots. ✅
4. **Advanced**: SDN, Ceph, QEMU monitor, subscription. ✅ (with the gaps marked above)
5. **Next**: the remaining ⬜ and 🟡 items, plus disk-full forecast, clean-up assistant, Cloudflare Tunnel, PWA.

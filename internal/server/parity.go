package server

import "fmt"

// Rotas "espelho" do painel do Proxmox (Fases 2 a 4): /api/pve/<caminho do PVE>.
// Cada uma lista os parâmetros aceitos; o resto é recusado.

var (
	storageParams = []string{"storage", "type", "content", "nodes", "disable", "shared", "path", "server", "export", "share",
		"username", "password", "domain", "datastore", "fingerprint", "namespace", "pool", "vgname", "thinpool", "sparse",
		"blocksize", "prune-backups", "mkdir", "create-base-path", "create-subdirs", "is_mountpoint", "options", "subdir",
		"smbversion", "port", "base", "saferemove", "krbd", "monhost", "fs-name", "preallocation", "format", "bwlimit",
		"max-protected-backups", "portal", "target", "skip-cert-verification", "delete", "digest"}
	notifyParams = []string{"name", "comment", "disable", "mailto", "mailto-user", "from-address", "author", "server", "port",
		"mode", "username", "password", "token", "url", "method", "header", "body", "secret", "delete", "digest"}
	matcherParams = []string{"name", "comment", "disable", "match-field", "match-severity", "match-calendar", "mode",
		"invert-match", "target", "delete", "digest"}
	ruleParams  = []string{"type", "action", "macro", "proto", "dport", "sport", "source", "dest", "iface", "comment", "enable", "log", "pos", "delete", "digest"}
	userParams  = []string{"email", "firstname", "lastname", "groups", "expire", "enable", "comment", "keys", "append", "delete"}
	realmParams = []string{"type", "comment", "default", "server1", "server2", "port", "base_dn", "user_attr", "bind_dn", "password",
		"secure", "mode", "verify", "issuer-url", "client-id", "client-key", "username-claim", "autocreate", "scopes", "prompt",
		"domain", "sync-defaults-options", "group_filter", "filter", "tfa", "case-sensitive", "delete", "digest"}
	sdnZoneParams = []string{"type", "bridge", "tag", "vlan-protocol", "peers", "mtu", "ipam", "dns", "reversedns", "dnszone",
		"nodes", "controller", "vrf-vxlan", "exitnodes", "mac", "dhcp", "delete", "digest"}
	metricParams = []string{"type", "server", "port", "disable", "mtu", "timeout", "path", "proto", "influxdbproto",
		"organization", "bucket", "token", "api-path-prefix", "max-body-size", "verify-certificate", "delete", "digest"}
	optionsParams = []string{"keyboard", "http_proxy", "email_from", "mac_prefix", "migration", "console", "language",
		"max_workers", "next-id", "tag-style", "user-tag-access", "registered-tags", "bwlimit", "ha", "crs", "description",
		"delete", "digest", "fencing", "notify", "webauthn", "u2f"}
	qemuCreateParams = []string{"vmid", "name", "ostype", "cores", "sockets", "cpu", "memory", "balloon", "scsihw",
		"scsi0", "scsi1", "scsi2", "scsi3", "sata0", "sata1", "sata2", "sata3", "ide0", "ide1", "ide2", "ide3", "virtio0",
		"net0", "net1", "net2", "net3", "boot", "bios", "machine", "efidisk0", "tpmstate0", "agent", "serial0", "vga",
		"ciuser", "cipassword", "sshkeys", "ipconfig0", "nameserver", "searchdomain", "citype", "ciupgrade", "onboot",
		"start", "description", "tags", "numa", "kvm", "acpi", "tablet", "arch", "live-restore"}
)

func pveRoutes() []fwdRoute {
	r := []fwdRoute{}
	add := func(method, path string, params ...string) {
		r = append(r, fwdRoute{pattern: method + " /api/pve" + path, pve: path, params: params})
	}

	// --- Fase 2: discos ---
	add("GET", "/nodes/{node}/disks/list", "include-partitions", "skipsmart", "type")
	add("GET", "/nodes/{node}/disks/smart", "disk", "healthonly")
	add("PUT", "/nodes/{node}/disks/wipedisk", "disk")
	add("POST", "/nodes/{node}/disks/initgpt", "disk", "uuid")
	add("GET", "/nodes/{node}/disks/zfs")
	add("POST", "/nodes/{node}/disks/zfs", "name", "raidlevel", "devices", "ashift", "compression", "add_storage", "draid-config")
	add("GET", "/nodes/{node}/disks/zfs/{name}")
	add("DELETE", "/nodes/{node}/disks/zfs/{name}", "cleanup-config", "cleanup-disks")
	for _, kind := range []string{"lvm", "lvmthin", "directory"} {
		add("GET", "/nodes/{node}/disks/"+kind)
		add("POST", "/nodes/{node}/disks/"+kind, "device", "name", "add_storage", "filesystem")
		add("DELETE", "/nodes/{node}/disks/"+kind+"/{name}", "cleanup-config", "cleanup-disks", "volume-group")
	}

	// --- Fase 2: definições de storage ---
	add("GET", "/storage", "type")
	add("POST", "/storage", storageParams...)
	add("GET", "/storage/{storage}")
	add("PUT", "/storage/{storage}", storageParams...)
	add("DELETE", "/storage/{storage}")
	add("GET", "/nodes/{node}/scan/nfs", "server")
	add("GET", "/nodes/{node}/scan/cifs", "server", "username", "password", "domain")
	add("GET", "/nodes/{node}/scan/pbs", "server", "username", "password", "fingerprint", "port")
	add("GET", "/nodes/{node}/scan/zfs")
	add("GET", "/nodes/{node}/scan/lvm")
	add("GET", "/nodes/{node}/scan/lvmthin", "vg")
	add("GET", "/nodes/{node}/scan/iscsi", "portal")
	add("GET", "/nodes/{node}/storage/{storage}/import-metadata", "volume")

	// --- Fase 2: sistema do nó ---
	add("GET", "/nodes/{node}/dns")
	add("PUT", "/nodes/{node}/dns", "search", "dns1", "dns2", "dns3", "delete")
	add("GET", "/nodes/{node}/hosts")
	add("POST", "/nodes/{node}/hosts", "data", "digest")
	add("GET", "/nodes/{node}/time")
	add("PUT", "/nodes/{node}/time", "timezone")
	add("GET", "/nodes/{node}/journal", "lastentries", "since", "until", "startcursor", "endcursor")
	add("GET", "/nodes/{node}/config", "property")
	add("PUT", "/nodes/{node}/config", "description", "wakeonlan", "acme", "acmedomain0", "acmedomain1", "acmedomain2",
		"acmedomain3", "acmedomain4", "startall-onboot-delay", "delete", "digest")
	add("POST", "/nodes/{node}/wakeonlan")
	add("GET", "/nodes/{node}/rrddata", "timeframe", "cf")
	add("GET", "/nodes/{node}/certificates/info")
	add("POST", "/nodes/{node}/certificates/custom", "certificates", "key", "restart", "force")
	add("DELETE", "/nodes/{node}/certificates/custom", "restart")
	add("POST", "/nodes/{node}/certificates/acme/certificate", "force")
	add("PUT", "/nodes/{node}/certificates/acme/certificate", "force")
	add("DELETE", "/nodes/{node}/certificates/acme/certificate")

	// --- Fase 2: ACME ---
	add("GET", "/cluster/acme/account")
	add("POST", "/cluster/acme/account", "name", "contact", "directory", "tos_url", "eab-kid", "eab-hmac-key")
	add("GET", "/cluster/acme/account/{name}")
	add("PUT", "/cluster/acme/account/{name}", "contact")
	add("DELETE", "/cluster/acme/account/{name}")
	add("GET", "/cluster/acme/directories")
	add("GET", "/cluster/acme/tos", "directory")
	add("GET", "/cluster/acme/plugins", "type")
	add("POST", "/cluster/acme/plugins", "id", "type", "api", "data", "disable", "nodes", "validation-delay")
	add("GET", "/cluster/acme/plugins/{id}")
	add("PUT", "/cluster/acme/plugins/{id}", "api", "data", "disable", "nodes", "validation-delay", "delete", "digest")
	add("DELETE", "/cluster/acme/plugins/{id}")
	add("GET", "/cluster/acme/challenge-schema")

	// --- Fase 2: notificações ---
	add("GET", "/cluster/notifications/targets")
	add("POST", "/cluster/notifications/targets/{name}/test")
	for _, kind := range []string{"sendmail", "smtp", "gotify", "webhook"} {
		base := "/cluster/notifications/endpoints/" + kind
		add("GET", base)
		add("POST", base, notifyParams...)
		add("GET", base+"/{name}")
		add("PUT", base+"/{name}", notifyParams...)
		add("DELETE", base+"/{name}")
	}
	add("GET", "/cluster/notifications/matchers")
	add("POST", "/cluster/notifications/matchers", matcherParams...)
	add("PUT", "/cluster/notifications/matchers/{name}", matcherParams...)
	add("DELETE", "/cluster/notifications/matchers/{name}")
	add("GET", "/cluster/notifications/matcher-fields")
	add("GET", "/cluster/notifications/matcher-field-values")

	// --- Fase 2: mapeamento de dispositivos ---
	for _, kind := range []string{"pci", "usb", "dir"} {
		base := "/cluster/mapping/" + kind
		add("GET", base)
		add("POST", base, "id", "description", "map", "mdev", "live-migration-capable")
		add("GET", base+"/{id}")
		add("PUT", base+"/{id}", "description", "map", "mdev", "live-migration-capable", "delete", "digest")
		add("DELETE", base+"/{id}")
	}

	// --- Fase 3: usuários, grupos, papéis, permissões, realms, pools ---
	add("GET", "/access/users", "enabled", "full")
	add("POST", "/access/users", p([]string{"userid", "password"}, userParams)...)
	add("GET", "/access/users/{userid}")
	add("PUT", "/access/users/{userid}", userParams...)
	add("DELETE", "/access/users/{userid}")
	add("PUT", "/access/password", "userid", "password", "confirmation-password")
	add("GET", "/access/users/{userid}/token")
	add("POST", "/access/users/{userid}/token/{tokenid}", "comment", "expire", "privsep")
	add("PUT", "/access/users/{userid}/token/{tokenid}", "comment", "expire", "privsep")
	add("DELETE", "/access/users/{userid}/token/{tokenid}")
	add("GET", "/access/tfa")
	add("GET", "/access/tfa/{userid}")
	add("POST", "/access/tfa/{userid}", "type", "description", "totp", "value", "password", "challenge")
	add("DELETE", "/access/tfa/{userid}/{id}", "password")
	add("GET", "/access/groups")
	add("POST", "/access/groups", "groupid", "comment")
	add("PUT", "/access/groups/{groupid}", "comment")
	add("DELETE", "/access/groups/{groupid}")
	add("GET", "/access/roles")
	add("POST", "/access/roles", "roleid", "privs")
	add("PUT", "/access/roles/{roleid}", "privs", "append")
	add("DELETE", "/access/roles/{roleid}")
	add("GET", "/access/acl")
	add("PUT", "/access/acl", "path", "roles", "users", "groups", "tokens", "propagate", "delete")
	add("GET", "/access/permissions", "path", "userid")
	add("GET", "/access/domains")
	add("POST", "/access/domains", p([]string{"realm"}, realmParams)...)
	add("GET", "/access/domains/{realm}")
	add("PUT", "/access/domains/{realm}", realmParams...)
	add("DELETE", "/access/domains/{realm}")
	add("POST", "/access/domains/{realm}/sync", "dry-run", "scope", "remove-vanished", "enable-new")
	add("GET", "/pools", "poolid", "type")
	add("POST", "/pools", "poolid", "comment")
	add("PUT", "/pools", "poolid", "comment", "vms", "storage", "delete", "allow-move")
	add("DELETE", "/pools", "poolid")

	// --- Fase 3: HA ---
	add("GET", "/cluster/ha/status/current")
	add("GET", "/cluster/ha/resources", "type")
	add("POST", "/cluster/ha/resources", "sid", "comment", "group", "max_relocate", "max_restart", "state", "failback")
	add("PUT", "/cluster/ha/resources/{sid}", "comment", "group", "max_relocate", "max_restart", "state", "failback", "delete", "digest")
	add("DELETE", "/cluster/ha/resources/{sid}")
	add("POST", "/cluster/ha/resources/{sid}/migrate", "node")
	add("POST", "/cluster/ha/resources/{sid}/relocate", "node")
	add("GET", "/cluster/ha/groups")
	add("POST", "/cluster/ha/groups", "group", "nodes", "comment", "nofailback", "restricted")
	add("PUT", "/cluster/ha/groups/{group}", "nodes", "comment", "nofailback", "restricted", "delete", "digest")
	add("DELETE", "/cluster/ha/groups/{group}")
	add("GET", "/cluster/ha/rules", "type")
	add("POST", "/cluster/ha/rules", "rule", "type", "resources", "nodes", "strict", "affinity", "comment", "disable")
	add("PUT", "/cluster/ha/rules/{rule}", "type", "resources", "nodes", "strict", "affinity", "comment", "disable", "delete", "digest")
	add("DELETE", "/cluster/ha/rules/{rule}")

	// --- Fase 3: replicação ---
	add("GET", "/cluster/replication")
	add("POST", "/cluster/replication", "id", "target", "type", "schedule", "rate", "comment", "disable", "source")
	add("PUT", "/cluster/replication/{id}", "schedule", "rate", "comment", "disable", "source", "delete", "digest")
	add("DELETE", "/cluster/replication/{id}", "force", "keep")
	add("GET", "/nodes/{node}/replication")
	add("POST", "/nodes/{node}/replication/{id}/schedule_now")
	add("GET", "/nodes/{node}/replication/{id}/log", "start", "limit")

	// --- Fase 3: cluster e opções do datacenter ---
	add("GET", "/cluster/config/nodes")
	add("GET", "/cluster/config/join", "node")
	add("POST", "/cluster/config", "clustername", "link0", "link1", "nodeid", "votes")
	add("POST", "/cluster/config/join", "hostname", "fingerprint", "password", "link0", "link1", "nodeid", "votes", "force")
	add("GET", "/cluster/config/totem")
	add("GET", "/cluster/options")
	add("PUT", "/cluster/options", optionsParams...)
	add("GET", "/cluster/log", "max")

	// --- Fase 3: firewall avançado ---
	add("GET", "/cluster/firewall/groups")
	add("POST", "/cluster/firewall/groups", "group", "comment", "rename", "digest")
	add("GET", "/cluster/firewall/groups/{group}")
	add("POST", "/cluster/firewall/groups/{group}", ruleParams...)
	add("DELETE", "/cluster/firewall/groups/{group}")
	add("PUT", "/cluster/firewall/groups/{group}/{pos}", ruleParams...)
	add("DELETE", "/cluster/firewall/groups/{group}/{pos}")
	add("GET", "/cluster/firewall/aliases")
	add("POST", "/cluster/firewall/aliases", "name", "cidr", "comment")
	add("PUT", "/cluster/firewall/aliases/{name}", "cidr", "comment", "rename", "digest")
	add("DELETE", "/cluster/firewall/aliases/{name}")
	add("GET", "/cluster/firewall/ipset")
	add("POST", "/cluster/firewall/ipset", "name", "comment", "rename", "digest")
	add("GET", "/cluster/firewall/ipset/{name}")
	add("POST", "/cluster/firewall/ipset/{name}", "cidr", "comment", "nomatch")
	add("DELETE", "/cluster/firewall/ipset/{name}")
	add("DELETE", "/cluster/firewall/ipset/{name}/{cidr}")
	add("GET", "/cluster/firewall/macros")
	add("GET", "/nodes/{node}/firewall/log", "limit", "start", "since", "until")

	// --- Fase 3: servidores de métricas ---
	add("GET", "/cluster/metrics/server")
	add("POST", "/cluster/metrics/server/{id}", metricParams...)
	add("PUT", "/cluster/metrics/server/{id}", metricParams...)
	add("DELETE", "/cluster/metrics/server/{id}")

	// --- Fase 3: Cloud-Init e importação (criar VM com import-from) ---
	add("POST", "/nodes/{node}/qemu", qemuCreateParams...)
	add("PUT", "/nodes/{node}/qemu/{vmid}/cloudinit")
	add("GET", "/nodes/{node}/qemu/{vmid}/cloudinit")
	add("PUT", "/nodes/{node}/qemu/{vmid}/resize", "disk", "size")

	// --- Fase 4: SDN ---
	add("GET", "/cluster/sdn")
	add("PUT", "/cluster/sdn")
	add("GET", "/cluster/sdn/zones", "type", "pending")
	add("POST", "/cluster/sdn/zones", p([]string{"zone"}, sdnZoneParams)...)
	add("PUT", "/cluster/sdn/zones/{zone}", sdnZoneParams...)
	add("DELETE", "/cluster/sdn/zones/{zone}")
	add("GET", "/cluster/sdn/vnets", "pending")
	add("POST", "/cluster/sdn/vnets", "vnet", "zone", "tag", "alias", "vlanaware", "isolate-ports")
	add("PUT", "/cluster/sdn/vnets/{vnet}", "zone", "tag", "alias", "vlanaware", "isolate-ports", "delete", "digest")
	add("DELETE", "/cluster/sdn/vnets/{vnet}")
	add("GET", "/cluster/sdn/vnets/{vnet}/subnets", "pending")
	add("POST", "/cluster/sdn/vnets/{vnet}/subnets", "subnet", "type", "gateway", "snat", "dnszoneprefix", "dhcp-range")
	add("PUT", "/cluster/sdn/vnets/{vnet}/subnets/{subnet}", "gateway", "snat", "dnszoneprefix", "dhcp-range", "delete", "digest")
	add("DELETE", "/cluster/sdn/vnets/{vnet}/subnets/{subnet}")
	add("GET", "/cluster/sdn/controllers")
	add("GET", "/cluster/sdn/ipams")
	add("GET", "/cluster/sdn/dns")

	// --- Fase 4: Ceph ---
	add("GET", "/cluster/ceph/status")
	add("GET", "/nodes/{node}/ceph/status")
	add("POST", "/nodes/{node}/ceph/init", "network", "cluster-network", "size", "min_size", "pg_bits")
	add("GET", "/nodes/{node}/ceph/osd")
	add("POST", "/nodes/{node}/ceph/osd", "dev", "db_dev", "wal_dev", "encrypted", "crush-device-class")
	add("DELETE", "/nodes/{node}/ceph/osd/{osdid}", "cleanup")
	add("POST", "/nodes/{node}/ceph/osd/{osdid}/in")
	add("POST", "/nodes/{node}/ceph/osd/{osdid}/out")
	add("GET", "/nodes/{node}/ceph/mon")
	add("POST", "/nodes/{node}/ceph/mon/{monid}", "mon-address")
	add("DELETE", "/nodes/{node}/ceph/mon/{monid}")
	add("GET", "/nodes/{node}/ceph/mgr")
	add("POST", "/nodes/{node}/ceph/mgr/{id}")
	add("DELETE", "/nodes/{node}/ceph/mgr/{id}")
	add("GET", "/nodes/{node}/ceph/pool")
	add("POST", "/nodes/{node}/ceph/pool", "name", "size", "min_size", "pg_num", "pg_autoscale_mode", "application", "add_storages", "crush_rule")
	add("DELETE", "/nodes/{node}/ceph/pool/{name}", "remove_storages", "force")
	add("GET", "/nodes/{node}/ceph/fs")
	add("POST", "/nodes/{node}/ceph/fs/{name}", "pg_num", "add-storage")
	add("GET", "/nodes/{node}/ceph/mds")
	add("POST", "/nodes/{node}/ceph/mds/{name}")

	// --- Fase 4: monitor do QEMU e assinatura ---
	add("POST", "/nodes/{node}/qemu/{vmid}/monitor", "command")
	add("GET", "/nodes/{node}/subscription")
	add("POST", "/nodes/{node}/subscription", "force")
	add("PUT", "/nodes/{node}/subscription", "key")
	add("DELETE", "/nodes/{node}/subscription")
	return r
}

// mustRoutes garante que nenhuma rota repete (o ServeMux entraria em pânico
// com uma mensagem pouco útil).
func mustRoutes(routes []fwdRoute) []fwdRoute {
	seen := map[string]bool{}
	for _, rt := range routes {
		if seen[rt.pattern] {
			panic(fmt.Sprintf("rota repetida: %s", rt.pattern))
		}
		seen[rt.pattern] = true
	}
	return routes
}

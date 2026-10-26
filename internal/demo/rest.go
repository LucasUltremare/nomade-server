package demo

import (
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Emulador REST genérico pro resto da API do PVE (definições de storage,
// usuários, HA, SDN, notificações...): coleções em memória por caminho.
// GET coleção lista, POST cria (id do campo certo), GET/PUT/DELETE no item.

type rest struct {
	mu    sync.Mutex
	colls map[string][]map[string]any // caminho da coleção -> itens
}

// idField: qual campo identifica os itens de cada coleção (e o parâmetro do POST).
var idField = []struct{ prefix, field, param string }{
	{"/storage", "storage", "storage"},
	{"/access/users/", "tokenid", "tokenid"}, // /access/users/{u}/token
	{"/access/users", "userid", "userid"},
	{"/access/groups", "groupid", "groupid"},
	{"/access/roles", "roleid", "roleid"},
	{"/access/domains", "realm", "realm"},
	{"/cluster/acme/plugins", "plugin", "id"},
	{"/cluster/acme/account", "name", "name"},
	{"/cluster/notifications/endpoints", "name", "name"},
	{"/cluster/notifications/matchers", "name", "name"},
	{"/cluster/mapping", "id", "id"},
	{"/cluster/ha/resources", "sid", "sid"},
	{"/cluster/ha/groups", "group", "group"},
	{"/cluster/ha/rules", "rule", "rule"},
	{"/cluster/replication", "id", "id"},
	{"/cluster/firewall/groups", "group", "group"},
	{"/cluster/firewall/aliases", "name", "name"},
	{"/cluster/firewall/ipset/", "cidr", "cidr"}, // entradas de um ipset
	{"/cluster/firewall/ipset", "name", "name"},
	{"/cluster/metrics/server", "id", "id"},
	{"/cluster/sdn/vnets/", "subnet", "subnet"}, // /cluster/sdn/vnets/{v}/subnets
	{"/cluster/sdn/zones", "zone", "zone"},
	{"/cluster/sdn/vnets", "vnet", "vnet"},
	{"/nodes/", "name", "name"},
}

func fieldFor(coll string) (field, param string) {
	for _, f := range idField {
		if strings.HasPrefix(coll, f.prefix) {
			return f.field, f.param
		}
	}
	return "id", "id"
}

func newRest() *rest {
	now := time.Now().Unix()
	r := &rest{colls: map[string][]map[string]any{}}
	r.colls["/storage"] = []map[string]any{
		{"storage": "local", "type": "dir", "path": "/var/lib/vz", "content": "iso,vztmpl,backup"},
		{"storage": "tank", "type": "zfspool", "pool": "tank", "content": "images,rootdir", "sparse": 1, "nodes": "pve-01,pve-02"},
		{"storage": "local-lvm", "type": "lvmthin", "vgname": "pve", "thinpool": "data", "content": "images,rootdir", "nodes": "pve-03"},
		{"storage": "nas-backup", "type": "pbs", "server": "10.0.10.5", "datastore": "homelab", "username": "backup@pbs", "content": "backup", "fingerprint": "3c:1a:…:9f", "prune-backups": "keep-all=1"},
	}
	r.colls["/access/users"] = []map[string]any{
		{"userid": "root@pam", "enable": 1, "expire": 0, "email": "root@pve-01.lan", "firstname": "", "realm-type": "pam", "tokens": []any{}},
		{"userid": "ana@pve", "enable": 1, "expire": 0, "email": "ana@example.com", "firstname": "Ana", "groups": "admins", "realm-type": "pve"},
		{"userid": "familia@pve", "enable": 1, "expire": 0, "comment": "Só liga e desliga o Jellyfin", "realm-type": "pve"},
		{"userid": "mia@pve", "enable": 1, "expire": 0, "comment": "Mia: agendamentos", "realm-type": "pve"},
	}
	r.colls["/access/users/mia@pve/token"] = []map[string]any{{"tokenid": "mia", "comment": "Mia", "privsep": 0, "expire": 0}}
	r.colls["/access/groups"] = []map[string]any{{"groupid": "admins", "comment": "Quem administra o homelab", "users": "ana@pve"}}
	builtins := map[string]string{
		"Administrator":    "Datastore.Allocate,Sys.Modify,VM.Allocate,Permissions.Modify",
		"PVEAdmin":         "VM.Allocate,VM.Config.Disk,Datastore.Allocate,Sys.Audit",
		"PVEVMAdmin":       "VM.Allocate,VM.Audit,VM.Config.CPU,VM.Console,VM.PowerMgmt,VM.Snapshot",
		"PVEVMUser":        "VM.Audit,VM.Console,VM.PowerMgmt,VM.Backup",
		"PVEAuditor":       "Datastore.Audit,Sys.Audit,VM.Audit",
		"PVEDatastoreUser": "Datastore.AllocateSpace,Datastore.Audit",
		"NoAccess":         "",
	}
	for id, privs := range builtins {
		r.colls["/access/roles"] = append(r.colls["/access/roles"], map[string]any{"roleid": id, "privs": privs, "special": 1})
	}
	r.colls["/access/roles"] = append(r.colls["/access/roles"], map[string]any{"roleid": "MiaJobs", "privs": "VM.Audit,VM.PowerMgmt,VM.Snapshot,VM.Backup,VM.Allocate,Datastore.AllocateSpace,Sys.Audit", "special": 0})
	r.colls["/access/domains"] = []map[string]any{
		{"realm": "pam", "type": "pam", "comment": "Linux PAM standard authentication"},
		{"realm": "pve", "type": "pve", "comment": "Proxmox VE authentication server", "default": 1},
	}
	r.colls["/cluster/ha/resources"] = []map[string]any{{"sid": "vm:107", "type": "vm", "state": "started", "max_restart": 1, "max_relocate": 1, "comment": "Home Assistant sempre de pé"}}
	r.colls["/cluster/ha/rules"] = []map[string]any{{"rule": "ha-casa", "type": "node-affinity", "resources": "vm:107", "nodes": "pve-02:2,pve-01:1", "strict": 0}}
	r.colls["/cluster/replication"] = []map[string]any{{"id": "103-0", "guest": 103, "target": "pve-01", "type": "local", "schedule": "*/15", "jobnum": 0, "source": "pve-02"}}
	r.colls["/cluster/notifications/endpoints/sendmail"] = []map[string]any{{"name": "mail-to-root", "mailto-user": "root@pam", "comment": "Padrão", "origin": "builtin"}}
	r.colls["/cluster/notifications/matchers"] = []map[string]any{{"name": "default-matcher", "target": "mail-to-root", "comment": "Manda tudo pro e-mail do root", "origin": "builtin"}}
	r.colls["/cluster/mapping/pci"] = []map[string]any{{"id": "gpu-3060", "description": "RTX 3060 pra VM de jogos", "map": []string{"node=pve-02,path=0000:01:00,id=10de:2504,iommugroup=14"}}}
	r.colls["/cluster/mapping/usb"] = []map[string]any{{"id": "zigbee", "description": "Sonoff Zigbee", "map": []string{"node=pve-02,id=1a86:55d4"}}}
	r.colls["/cluster/mapping/dir"] = []map[string]any{}
	r.colls["/cluster/firewall/groups"] = []map[string]any{{"group": "webserver", "comment": "HTTP e HTTPS"}}
	r.colls["/cluster/firewall/groups/webserver"] = []map[string]any{
		{"pos": 0, "type": "in", "action": "ACCEPT", "macro": "HTTPS", "enable": 1},
		{"pos": 1, "type": "in", "action": "ACCEPT", "macro": "HTTP", "enable": 1},
	}
	r.colls["/cluster/firewall/aliases"] = []map[string]any{{"name": "lan", "cidr": "10.0.10.0/24", "comment": "Rede de casa"}}
	r.colls["/cluster/firewall/ipset"] = []map[string]any{{"name": "management", "comment": "Quem pode acessar o painel"}}
	r.colls["/cluster/firewall/ipset/management"] = []map[string]any{{"cidr": "10.0.10.0/24"}, {"cidr": "100.64.0.0/10", "comment": "Tailscale"}}
	r.colls["/cluster/metrics/server"] = []map[string]any{}
	r.colls["/cluster/sdn/zones"] = []map[string]any{}
	r.colls["/cluster/sdn/vnets"] = []map[string]any{}
	r.colls["/cluster/acme/account"] = []map[string]any{}
	r.colls["/cluster/acme/plugins"] = []map[string]any{}
	_ = now
	return r
}

// handle tenta resolver o pedido como coleção/item; false se não é coisa do emulador.
func (r *rest) handle(w http.ResponseWriter, req *http.Request, esc string) bool {
	path, err := url.PathUnescape(esc)
	if err != nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	req.ParseForm()
	form := req.PostForm
	if req.Method == http.MethodGet || req.Method == http.MethodDelete {
		form = req.URL.Query()
	}
	if items, ok := r.colls[path]; ok {
		switch req.Method {
		case http.MethodGet:
			reply(w, items)
		case http.MethodPost:
			field, param := fieldFor(path)
			id := form.Get(param)
			if id == "" {
				id = form.Get(field)
			}
			if id == "" && field == "pos" || strings.HasPrefix(path, "/cluster/firewall/groups/") {
				// Regra de grupo: entra no topo.
				item := formMap(form)
				r.colls[path] = append([]map[string]any{item}, items...)
				for i := range r.colls[path] {
					r.colls[path][i]["pos"] = i
				}
				reply(w, nil)
				return true
			}
			if id == "" {
				fail(w, 400, "property is missing and it is not optional")
				return true
			}
			if slices.ContainsFunc(items, func(x map[string]any) bool { return fmt.Sprint(x[field]) == id }) {
				fail(w, 500, fmt.Sprintf("%s '%s' already exists", field, id))
				return true
			}
			item := formMap(form)
			delete(item, param)
			item[field] = id
			r.colls[path] = append(items, item)
			// Coleções filhas comuns.
			if path == "/cluster/firewall/groups" || path == "/cluster/firewall/ipset" {
				r.colls[path+"/"+id] = []map[string]any{}
			}
			if path == "/cluster/sdn/vnets" {
				r.colls[path+"/"+id+"/subnets"] = []map[string]any{}
			}
			if path == "/access/users" {
				r.colls[path+"/"+id+"/token"] = []map[string]any{}
			}
			reply(w, nil)
		default:
			fail(w, 501, "method not implemented")
		}
		return true
	}
	// Item: /coleção/{id} (o id pode ter "/" escapado, ex.: CIDR)
	i := strings.LastIndex(esc, "/")
	parent, _ := url.PathUnescape(esc[:i])
	id, _ := url.PathUnescape(esc[i+1:])
	items, ok := r.colls[parent]
	if !ok {
		return false
	}
	field, _ := fieldFor(parent)
	if strings.HasPrefix(parent, "/cluster/firewall/groups/") {
		field = "pos"
	}
	idx := slices.IndexFunc(items, func(x map[string]any) bool { return fmt.Sprint(x[field]) == id })
	switch req.Method {
	case http.MethodPost:
		// POST no item cria (ex.: /cluster/metrics/server/{id}, token).
		if idx >= 0 {
			fail(w, 500, "already exists")
			return true
		}
		item := formMap(form)
		item[field] = id
		r.colls[parent] = append(items, item)
		if strings.HasSuffix(parent, "/token") {
			reply(w, map[string]any{"full-tokenid": strings.TrimSuffix(strings.TrimPrefix(parent, "/access/users/"), "/token") + "!" + id,
				"value": token()[:8] + "-" + token()[:4] + "-" + token()[:4] + "-" + token()[:12], "info": map[string]any{"privsep": form.Get("privsep")}})
			return true
		}
		reply(w, nil)
		return true
	}
	if idx < 0 {
		fail(w, 404, fmt.Sprintf("no such %s '%s'", field, id))
		return true
	}
	switch req.Method {
	case http.MethodGet:
		// Grupo/ipset: o "item" é a lista de regras/entradas.
		if sub, ok := r.colls[path]; ok {
			reply(w, sub)
			return true
		}
		reply(w, items[idx])
	case http.MethodPut:
		for k, vs := range form {
			switch k {
			case "delete":
				for _, d := range strings.Split(vs[0], ",") {
					delete(items[idx], d)
				}
			case "digest":
			default:
				if len(vs) > 1 {
					items[idx][k] = vs
				} else {
					items[idx][k] = vs[0]
				}
			}
		}
		reply(w, nil)
	case http.MethodDelete:
		r.colls[parent] = slices.Delete(items, idx, idx+1)
		if field == "pos" {
			for j := range r.colls[parent] {
				r.colls[parent][j]["pos"] = j
			}
		}
		delete(r.colls, path)
		reply(w, nil)
	}
	return true
}

func formMap(f url.Values) map[string]any {
	m := map[string]any{}
	for k, vs := range f {
		if k == "digest" {
			continue
		}
		if len(vs) > 1 {
			m[k] = vs
			continue
		}
		if n, err := strconv.Atoi(vs[0]); err == nil && (vs[0] == "0" || vs[0] == "1") {
			m[k] = n
			continue
		}
		m[k] = vs[0]
	}
	return m
}

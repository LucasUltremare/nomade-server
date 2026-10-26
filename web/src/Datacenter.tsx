import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CrudSection, SpecForm, TaskButton, clean, dt, enc, pve, yes, type Field, type Values } from "./Crud";
import { useGuests, useStatus, useUI } from "./state";
import { Jobs } from "./Jobs";
import { Modal } from "./Dialogs";
import { bytes } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";

type R = Record<string, unknown>;
const s = (x: unknown) => (x === undefined || x === null ? "" : String(x));

const SECTIONS: [string, string, string][] = [
  ["Geral", "opcoes", "Opções e notas"],
  ["Geral", "cluster", "Cluster"],
  ["Geral", "log", "Log do cluster"],
  ["Armazenamento", "storages", "Storages"],
  ["Acesso", "usuarios", "Usuários e tokens"],
  ["Acesso", "grupos", "Grupos"],
  ["Acesso", "papeis", "Papéis"],
  ["Acesso", "permissoes", "Permissões"],
  ["Acesso", "realms", "Logins (realms)"],
  ["Acesso", "pools", "Pools"],
  ["Disponibilidade", "ha", "Alta disponibilidade"],
  ["Disponibilidade", "replicacao", "Replicação"],
  ["Rede", "sdn", "SDN"],
  ["Rede", "fw-grupos", "Grupos de firewall"],
  ["Rede", "fw-aliases", "Aliases e IPSets"],
  ["Integrações", "notificacoes", "Notificações"],
  ["Integrações", "acme", "ACME (Let's Encrypt)"],
  ["Integrações", "mapeamentos", "Mapeamento de dispositivos"],
  ["Integrações", "metricas", "Servidores de métricas"],
  ["Avançado", "ceph", "Ceph"],
  ["Mia", "agendamentos", "Agendamentos"],
];

export function DatacenterPage() {
  const [sec, setSec] = useState("opcoes");
  const groups = Array.from(new Set(SECTIONS.map(([g]) => g)));
  return (
    <div className="content dc">
      <aside className="dc-nav">
        {groups.map((g) => (
          <div key={g}>
            <div className="side-title">{g}</div>
            {SECTIONS.filter(([x]) => x === g).map(([, k, l]) => (
              <button key={k} className="list-btn" aria-pressed={sec === k} onClick={() => setSec(k)}><span className="name">{l}</span></button>
            ))}
          </div>
        ))}
      </aside>
      <div className="dc-main">
        <select className="dc-mobile scope-select" value={sec} onChange={(e) => setSec(e.target.value)} aria-label="Seção">
          {SECTIONS.map(([g, k, l]) => <option key={k} value={k}>{g} · {l}</option>)}
        </select>
        {sec === "opcoes" && <Options />}
        {sec === "cluster" && <Cluster />}
        {sec === "log" && <ClusterLog />}
        {sec === "storages" && <Storages />}
        {sec === "usuarios" && <Users />}
        {sec === "grupos" && <Groups />}
        {sec === "papeis" && <Roles />}
        {sec === "permissoes" && <Permissions />}
        {sec === "realms" && <Realms />}
        {sec === "pools" && <Pools />}
        {sec === "ha" && <HA />}
        {sec === "replicacao" && <Replication />}
        {sec === "sdn" && <SDN />}
        {sec === "fw-grupos" && <FwGroups />}
        {sec === "fw-aliases" && <FwAliases />}
        {sec === "notificacoes" && <Notifications />}
        {sec === "acme" && <Acme />}
        {sec === "mapeamentos" && <Mappings />}
        {sec === "metricas" && <Metrics />}
        {sec === "ceph" && <Ceph />}
        {sec === "agendamentos" && <Jobs />}
      </div>
    </div>
  );
}

// ---------- geral ----------

function Options() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["dc-options"], queryFn: () => pve.get<R>("/cluster/options") });
  if (!data) return <p className="muted">Carregando…</p>;
  const mig = s(data.migration);
  return (
    <section className="crud">
      <div className="section-head"><div><h2>Opções do datacenter</h2><p>Valem pra todos os nós.</p></div></div>
      <SpecForm key={JSON.stringify(data)} initial={{ ...data, migration_type: mig.match(/type=(\w+)/)?.[1] ?? "secure", migration_net: mig.match(/network=([^,]+)/)?.[1] ?? "" } as Values}
        fields={[
          { key: "description", label: "Notas do datacenter", type: "textarea" },
          { key: "keyboard", label: "Teclado do console", type: "select", options: [["", "padrão"], ["pt-br", "Português (Brasil)"], ["en-us", "Inglês (EUA)"], ["pt", "Português (Portugal)"]] },
          { key: "console", label: "Console padrão", type: "select", options: [["", "padrão"], ["xtermjs", "xterm.js"], ["html5", "noVNC"], ["vv", "SPICE"]] },
          { key: "email_from", label: "E-mail remetente", placeholder: "pve@seudominio" },
          { key: "http_proxy", label: "Proxy HTTP", placeholder: "http://proxy:3128" },
          { key: "mac_prefix", label: "Prefixo de MAC", placeholder: "BC:24:11" },
          { key: "next-id", label: "Faixa de IDs", placeholder: "lower=100,upper=999999" },
          { key: "migration_type", label: "Migração", type: "select", options: [["secure", "Segura (SSH)"], ["insecure", "Rápida (sem criptografia)"]] },
          { key: "migration_net", label: "Rede de migração", placeholder: "10.0.20.0/24 (opcional)" },
          { key: "tag-style", label: "Estilo das tags", placeholder: "shape=circle" },
        ]}
        onSubmit={async (v) => {
          const body: R = {};
          for (const k of ["description", "keyboard", "console", "email_from", "http_proxy", "mac_prefix", "next-id", "tag-style"]) body[k] = v[k];
          body.migration = `type=${v.migration_type}${v.migration_net ? `,network=${v.migration_net}` : ""}`;
          const del = Object.entries(body).filter(([, x]) => x === "").map(([k]) => k);
          for (const k of del) delete body[k];
          if (del.length) body.delete = del.join(",");
          await pve.put("/cluster/options", body);
          qc.invalidateQueries({ queryKey: ["dc-options"] });
        }} />
    </section>
  );
}

function Cluster() {
  const { data: status } = useStatus();
  const { data: nodes } = useQuery({ queryKey: ["cluster-nodes"], queryFn: () => pve.get<R[]>("/cluster/config/nodes").catch(() => []) });
  const { data: join } = useQuery({ queryKey: ["cluster-join"], queryFn: () => pve.get<R>("/cluster/config/join").catch(() => null) });
  const [mode, setMode] = useState<"" | "create" | "join">("");
  const [upid, setUpid] = useState("");
  const standalone = status?.cluster.standalone;
  const joinInfo = join ? b64(JSON.stringify({ ipAddress: (join.nodelist as R[])?.[0]?.pve_addr, fingerprint: (join.nodelist as R[])?.[0]?.pve_fp, peerLinks: {}, ring_addr: [], totem: join.totem })) : "";
  return (
    <section className="crud">
      <div className="section-head">
        <div><h2>Cluster</h2><p>{standalone ? "Este nó está sozinho." : `Cluster "${status?.cluster.name}" com ${status?.cluster.nodes} nós.`}</p></div>
        <div style={{ display: "flex", gap: 8 }}>
          {standalone && <button className="btn small primary" onClick={() => setMode("create")}>Criar cluster</button>}
          <button className="btn small" onClick={() => setMode("join")}>Entrar num cluster</button>
        </div>
      </div>
      {!!nodes?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nó</th><th>ID</th><th>Votos</th><th>Endereço do cluster</th></tr></thead>
            <tbody>{nodes.map((n) => <tr key={s(n.node)} style={{ cursor: "default" }}><td className="mono">{s(n.node)}</td><td className="mono">{s(n.nodeid)}</td><td className="mono">{s(n.quorum_votes)}</td><td className="mono">{s(n.ring0_addr)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {joinInfo && !standalone && (
        <>
          <div className="hw-title">Informação pra outro nó entrar</div>
          <textarea className="code" rows={3} readOnly value={joinInfo} onFocus={(e) => e.target.select()} />
          <p className="muted" style={{ fontSize: 12 }}>Cole isso no "Entrar num cluster" do nó novo (Mia ou painel do Proxmox).</p>
        </>
      )}
      {upid && <TaskLogInline upid={upid} />}
      {mode && (
        <Modal label="Cluster" onClose={() => setMode("")} className="wide">
          <button className="close" onClick={() => setMode("")} aria-label="Fechar"><IconX /></button>
          <h2>{mode === "create" ? "Criar cluster" : "Entrar num cluster"}</h2>
          {mode === "join" && <div className="warn">Este nó não pode ter VMs nem contêineres pra entrar num cluster.</div>}
          <SpecForm
            fields={mode === "create" ? [
              { key: "clustername", label: "Nome do cluster", required: true, placeholder: "homelab" },
              { key: "link0", label: "Rede do cluster (opcional)", placeholder: "IP deste nó na rede dedicada" },
            ] : [
              { key: "info", label: "Informação de entrada", type: "textarea", required: true, help: "Copie de Datacenter → Cluster no nó que já está no cluster." },
              { key: "password", label: "Senha do root do outro nó", type: "password", required: true },
            ]}
            submitLabel={mode === "create" ? "Criar" : "Entrar"}
            onCancel={() => setMode("")}
            onSubmit={async (v) => {
              if (mode === "create") {
                setUpid(await pve.post<string>("/cluster/config", clean(v)));
              } else {
                const info = JSON.parse(atob(String(v.info).trim()));
                setUpid(await pve.post<string>("/cluster/config/join", { hostname: info.ipAddress, fingerprint: info.fingerprint, password: v.password }));
              }
              setMode("");
            }} />
        </Modal>
      )}
    </section>
  );
}

function TaskLogInline({ upid }: { upid: string }) {
  return <div className="task-inline"><TaskLog upid={upid} /></div>;
}

function ClusterLog() {
  const { data } = useQuery({ queryKey: ["cluster-log"], queryFn: () => pve.get<R[]>("/cluster/log", { max: 200 }), refetchInterval: 15_000 });
  return (
    <section className="crud">
      <div className="section-head"><h2>Log do cluster</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Quando</th><th>Nó</th><th>Serviço</th><th>Usuário</th><th>Mensagem</th></tr></thead>
          <tbody>
            {(data ?? []).map((l) => (
              <tr key={`${s(l.uid)}-${s(l.time)}`} style={{ cursor: "default" }}>
                <td className="mono">{dt(l.time)}</td><td className="mono">{s(l.node)}</td><td className="mono">{s(l.tag)}</td><td className="mono">{s(l.user)}</td><td>{s(l.msg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- storages ----------

const CONTENT: [string, string][] = [["images", "Discos de VM"], ["rootdir", "Discos de CT"], ["iso", "ISO"], ["vztmpl", "Templates CT"], ["backup", "Backups"], ["snippets", "Snippets"], ["import", "Importação"]];
const STORAGE_TYPES: [string, string][] = [["dir", "Diretório"], ["nfs", "NFS"], ["cifs", "SMB/CIFS"], ["pbs", "Proxmox Backup Server"], ["zfspool", "ZFS"], ["lvmthin", "LVM-thin"], ["lvm", "LVM"], ["btrfs", "BTRFS"], ["esxi", "VMware ESXi (importar VMs)"]];

function storageFields(editing: R | null, nodes: string[]): Field[] {
  const t = (v: Values) => String(v.type);
  return [
    { key: "storage", label: "ID", required: true, fixed: true, placeholder: "nas-backup" },
    { key: "type", label: "Tipo", type: "select", options: STORAGE_TYPES, fixed: true },
    { key: "path", label: "Caminho", placeholder: "/mnt/dados", show: (v) => ["dir", "btrfs"].includes(t(v)), required: true },
    { key: "server", label: "Servidor", placeholder: "10.0.10.5", show: (v) => ["nfs", "cifs", "pbs", "esxi"].includes(t(v)), required: true },
    { key: "export", label: "Export NFS", placeholder: "/mnt/tank/backups", show: (v) => t(v) === "nfs", required: true },
    { key: "share", label: "Compartilhamento", placeholder: "backups", show: (v) => t(v) === "cifs", required: true },
    { key: "datastore", label: "Datastore", placeholder: "homelab", show: (v) => t(v) === "pbs", required: true },
    { key: "username", label: "Usuário", show: (v) => ["cifs", "pbs", "esxi"].includes(t(v)), placeholder: "backup@pbs ou root" },
    { key: "password", label: editing ? "Senha (deixe vazio pra manter)" : "Senha", type: "password", show: (v) => ["cifs", "pbs", "esxi"].includes(t(v)) },
    { key: "skip-cert-verification", label: "Aceitar certificado sem verificar (padrão do ESXi)", type: "checkbox", show: (v) => t(v) === "esxi" },
    { key: "domain", label: "Domínio", show: (v) => t(v) === "cifs" },
    { key: "fingerprint", label: "Fingerprint do PBS", show: (v) => t(v) === "pbs", placeholder: "aa:bb:…", wide: true },
    { key: "pool", label: "Pool ZFS", show: (v) => t(v) === "zfspool", required: true, placeholder: "tank/vms" },
    { key: "vgname", label: "Volume group", show: (v) => ["lvm", "lvmthin"].includes(t(v)), required: true, placeholder: "pve" },
    { key: "thinpool", label: "Thin pool", show: (v) => t(v) === "lvmthin", required: true, placeholder: "data" },
    { key: "content", label: "Conteúdo", type: "multi", options: CONTENT, show: (v) => !["pbs", "esxi"].includes(t(v)) },
    { key: "nodes", label: "Só nestes nós (vazio = todos)", type: "multi", options: nodes.map((n) => [n, n]) },
    { key: "prune-backups", label: "Retenção de backups", placeholder: "keep-last=7,keep-weekly=4", show: (v) => !["zfspool", "lvmthin", "lvm", "esxi"].includes(t(v)) },
    { key: "shared", label: "Compartilhado entre nós", type: "checkbox", show: (v) => ["dir", "lvm"].includes(t(v)) },
    { key: "disable", label: "Desativado", type: "checkbox" },
  ];
}

function Storages() {
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).map((n) => n.name);
  const toBody = (v: Values, creating: boolean) => {
    const body = clean(v, { joinMulti: ",", keep: creating ? [] : ["nodes"] });
    if (!creating) {
      delete body.storage;
      delete body.type;
      if (!body.password) delete body.password;
      if (body.nodes === "") { delete body.nodes; body.delete = "nodes"; }
    }
    return body;
  };
  return (
    <CrudSection<R>
      title="Storages"
      help="Onde o Proxmox guarda discos, ISOs, templates e backups. NFS, SMB e PBS são da rede; os outros, de discos do nó."
      queryKey={["storage-config"]}
      list={() => pve.get<R[]>("/storage")}
      idOf={(r) => s(r.storage)}
      columns={[
        { label: "ID", render: (r) => s(r.storage), mono: true },
        { label: "Tipo", render: (r) => STORAGE_TYPES.find(([k]) => k === r.type)?.[1] ?? s(r.type) },
        { label: "Onde", render: (r) => s(r.path || (r.server ? `${s(r.server)}:${s(r.export || r.share || r.datastore)}` : r.pool || r.vgname)), mono: true },
        { label: "Conteúdo", render: (r) => s(r.content) },
        { label: "Nós", render: (r) => s(r.nodes) || "todos" },
        { label: "Ativo", render: (r) => (yes(r.disable) ? "não" : "sim") },
      ]}
      fields={(e) => storageFields(e, nodes)}
      toForm={(r) => ({ ...r, content: s(r.content).split(",").filter(Boolean), nodes: s(r.nodes).split(",").filter(Boolean), disable: yes(r.disable), shared: yes(r.shared), password: "" } as Values)}
      create={(v) => pve.post("/storage", toBody(v, true))}
      update={(r, v) => pve.put(`/storage/${enc(s(r.storage))}`, toBody(v, false))}
      remove={(r) => pve.del(`/storage/${enc(s(r.storage))}`)}
      createLabel="Adicionar storage"
    />
  );
}

// ---------- acesso ----------

function Users() {
  const [tfaFor, setTfaFor] = useState<string | null>(null);
  const [tokensFor, setTokensFor] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const { data: groups } = useQuery({ queryKey: ["groups"], queryFn: () => pve.get<R[]>("/access/groups") });
  const { data: realms } = useQuery({ queryKey: ["realms-cfg"], queryFn: () => pve.get<R[]>("/access/domains") });
  return (
    <>
      <CrudSection<R>
        title="Usuários"
        help="Contas do Proxmox. Usuários @pam são do Linux do nó; @pve são só do Proxmox."
        queryKey={["users"]}
        list={() => pve.get<R[]>("/access/users", { full: 1 })}
        idOf={(r) => s(r.userid)}
        columns={[
          { label: "Usuário", render: (r) => s(r.userid), mono: true },
          { label: "Nome", render: (r) => `${s(r.firstname)} ${s(r.lastname)}`.trim() || "—" },
          { label: "E-mail", render: (r) => s(r.email) || "—" },
          { label: "Grupos", render: (r) => s(r.groups) || "—" },
          { label: "Ativo", render: (r) => (r.enable === 0 || r.enable === "0" ? "não" : "sim") },
          { label: "Comentário", render: (r) => s(r.comment) },
        ]}
        fields={(e) => [
          { key: "username", label: "Usuário", required: true, fixed: true, show: () => !e, placeholder: "familia" },
          { key: "realm", label: "Realm", type: "select", show: () => !e, options: (realms ?? []).map((r) => [s(r.realm), s(r.realm)]) },
          { key: "password", label: "Senha", type: "password", show: (v) => !e && v.realm === "pve" },
          { key: "firstname", label: "Nome" },
          { key: "lastname", label: "Sobrenome" },
          { key: "email", label: "E-mail", wide: true },
          { key: "groups", label: "Grupos", type: "multi", options: (groups ?? []).map((g) => [s(g.groupid), s(g.groupid)]) },
          { key: "comment", label: "Comentário", wide: true },
          { key: "enable", label: "Ativo", type: "checkbox" },
        ]}
        toForm={(r) => ({ ...r, groups: s(r.groups).split(",").filter(Boolean), enable: !(r.enable === 0 || r.enable === "0") } as Values)}
        create={(v) => pve.post("/access/users", clean({ userid: `${v.username}@${v.realm || "pve"}`, password: v.password, firstname: v.firstname, lastname: v.lastname, email: v.email, groups: v.groups, comment: v.comment, enable: v.enable }, { joinMulti: "," }))}
        update={(r, v) => pve.put(`/access/users/${enc(s(r.userid))}`, clean({ firstname: v.firstname, lastname: v.lastname, email: v.email, groups: v.groups, comment: v.comment, enable: v.enable }, { joinMulti: ",", keep: ["groups"] }))}
        remove={(r) => pve.del(`/access/users/${enc(s(r.userid))}`)}
        rowActions={(r) => (
          <>
            {String(r.userid).endsWith("@pve") && <button className="btn small" onClick={() => setPwFor(s(r.userid))}>Senha</button>}{" "}
            <button className="btn small" onClick={() => setTokensFor(s(r.userid))}>Tokens</button>{" "}
            <button className="btn small" onClick={() => setTfaFor(s(r.userid))}>2FA</button>{" "}
          </>
        )}
        createLabel="Novo usuário"
      />
      {pwFor && (
        <Modal label="Senha" onClose={() => setPwFor(null)}>
          <button className="close" onClick={() => setPwFor(null)} aria-label="Fechar"><IconX /></button>
          <h2>Trocar senha de {pwFor}</h2>
          <SpecForm fields={[{ key: "password", label: "Nova senha", type: "password", required: true }, { key: "confirmation-password", label: "Sua senha (root)", type: "password", required: true }]}
            onCancel={() => setPwFor(null)} onSubmit={async (v) => { await pve.put("/access/password", { userid: pwFor, ...v }); setPwFor(null); }} />
        </Modal>
      )}
      {tokensFor && <Tokens user={tokensFor} onClose={() => setTokensFor(null)} />}
      {tfaFor && <Tfa user={tfaFor} onClose={() => setTfaFor(null)} />}
    </>
  );
}

function Tokens({ user, onClose }: { user: string; onClose: () => void }) {
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  return (
    <Modal label="Tokens" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      {secret && (
        <div className="warn">
          Guarde agora: o segredo não aparece de novo.<br />
          <span className="mono" style={{ wordBreak: "break-all" }}>{secret.id}={secret.value}</span>
        </div>
      )}
      <CrudSection<R>
        title={`Tokens de API de ${user}`}
        help="Pra scripts e integrações (Home Assistant, Terraform…). Com separação de privilégio, o token só tem as permissões dadas a ele."
        queryKey={["tokens", user]}
        list={() => pve.get<R[]>(`/access/users/${enc(user)}/token`)}
        idOf={(r) => s(r.tokenid)}
        columns={[
          { label: "Token", render: (r) => `${user}!${s(r.tokenid)}`, mono: true },
          { label: "Separação de privilégio", render: (r) => (yes(r.privsep) ? "sim" : "não") },
          { label: "Expira", render: (r) => (Number(r.expire) ? dt(r.expire) : "nunca") },
          { label: "Comentário", render: (r) => s(r.comment) },
        ]}
        fields={[
          { key: "tokenid", label: "Nome", required: true, fixed: true, placeholder: "homeassistant" },
          { key: "comment", label: "Comentário", wide: true },
          { key: "privsep", label: "Separação de privilégio (recomendado)", type: "checkbox" },
        ]}
        create={async (v) => {
          const r = await pve.post<{ "full-tokenid": string; value: string }>(`/access/users/${enc(user)}/token/${enc(String(v.tokenid))}`, clean({ comment: v.comment, privsep: v.privsep }));
          setSecret({ id: r["full-tokenid"], value: r.value });
        }}
        remove={(r) => pve.del(`/access/users/${enc(user)}/token/${enc(s(r.tokenid))}`)}
        createLabel="Novo token"
      />
    </Modal>
  );
}

function randomBase32(n = 32) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => a[x % 32]).join("");
}

function Tfa({ user, onClose }: { user: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["tfa"], queryFn: () => pve.get<{ userid: string; entries: R[] }[]>("/access/tfa") });
  const entries = data?.find((x) => x.userid === user)?.entries ?? [];
  const [secret] = useState(randomBase32);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const uri = `otpauth://totp/${encodeURIComponent(`Proxmox:${user}`)}?secret=${secret}&issuer=Proxmox`;
  const refresh = () => qc.invalidateQueries({ queryKey: ["tfa"] });
  return (
    <Modal label="2FA" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Segundo fator de {user}</h2>
      <div className="disk-list" style={{ marginTop: 12 }}>
        {entries.map((e) => (
          <div key={s(e.id)} className="disk">
            <div className="disk-main"><div><b>{s(e.type).toUpperCase()}</b><span className="muted"> · {s(e.description)}</span></div><div className="mono muted disk-vol">criado {dt(e.created)}</div></div>
            <div />
            <div className="disk-actions"><TaskButton label="Remover" danger confirm="Confirmar" run={() => pve.del(`/access/tfa/${enc(user)}/${enc(s(e.id))}`)} onDone={refresh} /></div>
          </div>
        ))}
        {!entries.length && <p className="muted" style={{ fontSize: 13 }}>Nenhum segundo fator.</p>}
      </div>
      <div className="hw-title">Adicionar app autenticador (TOTP)</div>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
        No app (Google Authenticator, 1Password, Aegis…), adicione manualmente com a chave abaixo ou abra o link no celular.
      </p>
      <div className="cmd-preview mono" style={{ marginTop: 0 }}>{secret}</div>
      <a className="btn small" href={uri} style={{ marginTop: 8 }}>Abrir no app autenticador</a>
      <SpecForm fields={[
        { key: "description", label: "Nome do aparelho", placeholder: "celular" },
        { key: "value", label: "Código que o app mostra agora", required: true, placeholder: "123456" },
        { key: "password", label: "Sua senha", type: "password", required: true },
      ]} submitLabel="Adicionar TOTP" onSubmit={async (v) => {
        await pve.post(`/access/tfa/${enc(user)}`, { type: "totp", totp: uri, value: v.value, description: v.description || "app", password: v.password });
        refresh();
      }} />
      <div className="dialog-actions">
        <TaskButton label="Gerar códigos de recuperação" small={false} run={async () => {
          const pw = window.prompt("Sua senha:");
          if (!pw) return;
          const r = await pve.post<{ recovery?: string[] }>(`/access/tfa/${enc(user)}`, { type: "recovery", password: pw });
          setRecovery(r.recovery ?? []);
          refresh();
        }} />
      </div>
      {recovery && <div className="warn">Guarde estes códigos (cada um vale uma vez):<pre className="mono">{recovery.join("\n")}</pre></div>}
    </Modal>
  );
}

function Groups() {
  return (
    <CrudSection<R> title="Grupos" help="Junte usuários pra dar permissão de uma vez." queryKey={["groups"]}
      list={() => pve.get<R[]>("/access/groups")} idOf={(r) => s(r.groupid)}
      columns={[{ label: "Grupo", render: (r) => s(r.groupid), mono: true }, { label: "Membros", render: (r) => s(r.users) || "—" }, { label: "Comentário", render: (r) => s(r.comment) }]}
      fields={[{ key: "groupid", label: "Nome", required: true, fixed: true }, { key: "comment", label: "Comentário", wide: true }]}
      create={(v) => pve.post("/access/groups", clean(v))}
      update={(r, v) => pve.put(`/access/groups/${enc(s(r.groupid))}`, { comment: v.comment })}
      remove={(r) => pve.del(`/access/groups/${enc(s(r.groupid))}`)} createLabel="Novo grupo" />
  );
}

const PRIVS = ["Datastore.Allocate", "Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Datastore.Audit", "Mapping.Audit", "Mapping.Modify", "Mapping.Use",
  "Permissions.Modify", "Pool.Allocate", "Pool.Audit", "Realm.Allocate", "Realm.AllocateUser", "SDN.Allocate", "SDN.Audit", "SDN.Use", "Sys.Audit", "Sys.Console",
  "Sys.Incoming", "Sys.Modify", "Sys.PowerMgmt", "Sys.Syslog", "User.Modify", "VM.Allocate", "VM.Audit", "VM.Backup", "VM.Clone", "VM.Config.CDROM",
  "VM.Config.CPU", "VM.Config.Cloudinit", "VM.Config.Disk", "VM.Config.HWType", "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "VM.Console",
  "VM.GuestAgent.Audit", "VM.GuestAgent.Unrestricted", "VM.Migrate", "VM.PowerMgmt", "VM.Snapshot", "VM.Snapshot.Rollback"];

function Roles() {
  return (
    <CrudSection<R> title="Papéis" help="Conjuntos de privilégios. Os padrões do Proxmox não podem ser editados." queryKey={["roles"]}
      list={() => pve.get<R[]>("/access/roles")} idOf={(r) => s(r.roleid)}
      columns={[{ label: "Papel", render: (r) => s(r.roleid), mono: true }, { label: "Tipo", render: (r) => (yes(r.special) ? "padrão" : "seu") }, { label: "Privilégios", render: (r) => <span className="muted" style={{ fontSize: 12 }}>{s(r.privs).split(",").join(", ")}</span> }]}
      fields={[{ key: "roleid", label: "Nome", required: true, fixed: true }, { key: "privs", label: "Privilégios", type: "multi", options: PRIVS.map((p) => [p, p]) }]}
      toForm={(r) => ({ roleid: s(r.roleid), privs: s(r.privs).split(",").filter(Boolean) })}
      create={(v) => pve.post("/access/roles", clean(v, { joinMulti: "," }))}
      update={(r, v) => pve.put(`/access/roles/${enc(s(r.roleid))}`, { privs: (v.privs as string[]).join(",") })}
      remove={(r) => pve.del(`/access/roles/${enc(s(r.roleid))}`)} createLabel="Novo papel" />
  );
}

function Permissions() {
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: () => pve.get<R[]>("/access/users") });
  const { data: groups } = useQuery({ queryKey: ["groups"], queryFn: () => pve.get<R[]>("/access/groups") });
  const { data: roles } = useQuery({ queryKey: ["roles"], queryFn: () => pve.get<R[]>("/access/roles") });
  const { data: guests } = useGuests();
  const paths = ["/", "/vms", "/storage", "/nodes", "/pool", "/sdn", ...(guests ?? []).map((g) => `/vms/${g.vmid}`)];
  const who = [...(users ?? []).map((u) => [`user:${s(u.userid)}`, `usuário ${s(u.userid)}`] as [string, string]), ...(groups ?? []).map((g) => [`group:${s(g.groupid)}`, `grupo ${s(g.groupid)}`] as [string, string])];
  const body = (r: R, del: boolean) => ({ path: r.path, roles: r.roleid, [r.type === "group" ? "groups" : r.type === "token" ? "tokens" : "users"]: r.ugid, ...(del ? { delete: 1 } : { propagate: r.propagate ? 1 : 0 }) });
  return (
    <CrudSection<R> title="Permissões" help="Quem pode o quê, e onde. Ex.: dar PVEVMUser em /vms/101 deixa ligar e desligar só aquele guest."
      queryKey={["acl"]} list={() => pve.get<R[]>("/access/acl")} idOf={(r) => `${s(r.path)}|${s(r.ugid)}|${s(r.roleid)}`}
      columns={[{ label: "Onde", render: (r) => s(r.path), mono: true }, { label: "Quem", render: (r) => `${s(r.type) === "group" ? "grupo" : s(r.type) === "token" ? "token" : "usuário"} ${s(r.ugid)}` }, { label: "Papel", render: (r) => s(r.roleid), mono: true }, { label: "Herda", render: (r) => (yes(r.propagate) ? "sim" : "não") }]}
      fields={[
        { key: "path", label: "Onde", type: "select", options: paths.map((p) => [p, p]) },
        { key: "who", label: "Quem", type: "select", options: [["", "Escolha…"], ...who] },
        { key: "roleid", label: "Papel", type: "select", options: (roles ?? []).map((r) => [s(r.roleid), s(r.roleid)]) },
        { key: "propagate", label: "Vale também pra dentro (subcaminhos)", type: "checkbox" },
      ]}
      create={(v) => {
        const [type, ugid] = String(v.who).split(":");
        return pve.put("/access/acl", body({ path: v.path || "/", type, ugid, roleid: v.roleid || "PVEAuditor", propagate: v.propagate }, false));
      }}
      remove={(r) => pve.put("/access/acl", body(r, true))} createLabel="Dar permissão" />
  );
}

function Realms() {
  return (
    <CrudSection<R> title="Logins (realms)" help="De onde vêm os usuários: Linux (PAM), o próprio Proxmox, LDAP, Active Directory ou OpenID (Google, Authentik, Keycloak…)."
      queryKey={["realms-cfg"]} list={() => pve.get<R[]>("/access/domains")} idOf={(r) => s(r.realm)}
      columns={[{ label: "Realm", render: (r) => s(r.realm), mono: true }, { label: "Tipo", render: (r) => s(r.type) }, { label: "Padrão", render: (r) => (yes(r.default) ? "sim" : "") }, { label: "Comentário", render: (r) => s(r.comment) }]}
      fields={(e) => [
        { key: "realm", label: "Nome", required: true, fixed: true },
        { key: "type", label: "Tipo", type: "select", fixed: true, options: [["openid", "OpenID Connect"], ["ldap", "LDAP"], ["ad", "Active Directory"]] },
        { key: "issuer-url", label: "Issuer URL", show: (v) => v.type === "openid", required: true, placeholder: "https://accounts.google.com", wide: true },
        { key: "client-id", label: "Client ID", show: (v) => v.type === "openid", required: true },
        { key: "client-key", label: "Client secret", type: "password", show: (v) => v.type === "openid" },
        { key: "username-claim", label: "Usuário vem de", type: "select", show: (v) => v.type === "openid", options: [["", "subject"], ["email", "e-mail"], ["username", "username"]] },
        { key: "autocreate", label: "Criar usuário no primeiro login", type: "checkbox", show: (v) => v.type === "openid" },
        { key: "server1", label: "Servidor", show: (v) => v.type !== "openid", required: true },
        { key: "port", label: "Porta", type: "number", show: (v) => v.type !== "openid" },
        { key: "base_dn", label: "Base DN", show: (v) => v.type === "ldap", placeholder: "dc=casa,dc=lan", wide: true },
        { key: "user_attr", label: "Atributo do usuário", show: (v) => v.type === "ldap", placeholder: "uid" },
        { key: "domain", label: "Domínio", show: (v) => v.type === "ad", placeholder: "casa.lan" },
        { key: "bind_dn", label: "Bind DN", show: (v) => v.type !== "openid", wide: true },
        { key: "password", label: "Senha do bind", type: "password", show: (v) => v.type !== "openid" },
        { key: "mode", label: "Conexão", type: "select", show: (v) => v.type !== "openid", options: [["ldap", "LDAP"], ["ldaps", "LDAPS"], ["ldap+starttls", "STARTTLS"]] },
        { key: "default", label: "Realm padrão na tela de login", type: "checkbox" },
        { key: "comment", label: "Comentário", wide: true },
        ...(e && ["pam", "pve"].includes(s(e.type)) ? [] : []),
      ]}
      toForm={(r) => ({ ...r, default: yes(r.default), autocreate: yes(r.autocreate) } as Values)}
      create={(v) => pve.post("/access/domains", clean(v))}
      update={(r, v) => { const b = clean(v); delete b.realm; delete b.type; return pve.put(`/access/domains/${enc(s(r.realm))}`, b); }}
      remove={(r) => pve.del(`/access/domains/${enc(s(r.realm))}`)}
      rowActions={(r) => (["ldap", "ad"].includes(s(r.type)) ? <TaskButton label="Sincronizar" run={() => pve.post(`/access/domains/${enc(s(r.realm))}/sync`, { scope: "both" })} /> : null)}
      createLabel="Novo realm" />
  );
}

function Pools() {
  const { data: guests } = useGuests();
  return (
    <CrudSection<R> title="Pools" help="Agrupe guests e storages (ex.: 'casa', 'mídia') pra organizar e dar permissão junto."
      queryKey={["pools"]} list={() => pve.get<R[]>("/pools")} idOf={(r) => s(r.poolid)}
      columns={[{ label: "Pool", render: (r) => s(r.poolid), mono: true }, { label: "Membros", render: (r) => ((r.members as R[]) ?? []).map((m) => s(m.name || m.storage || m.id)).join(", ") || "—" }, { label: "Comentário", render: (r) => s(r.comment) }]}
      fields={[
        { key: "poolid", label: "Nome", required: true, fixed: true },
        { key: "comment", label: "Comentário", wide: true },
        { key: "vms", label: "Guests", type: "multi", options: (guests ?? []).map((g) => [String(g.vmid), `${g.vmid} ${g.name}`]) },
      ]}
      toForm={(r) => ({ poolid: s(r.poolid), comment: s(r.comment), vms: ((r.members as R[]) ?? []).filter((m) => m.vmid).map((m) => s(m.vmid)) })}
      create={async (v) => {
        await pve.post("/pools", { poolid: v.poolid, comment: v.comment });
        if ((v.vms as string[]).length) await pve.put("/pools", { poolid: v.poolid, vms: (v.vms as string[]).join(",") });
      }}
      update={async (r, v) => {
        const before = ((r.members as R[]) ?? []).filter((m) => m.vmid).map((m) => s(m.vmid));
        const after = v.vms as string[];
        const rm = before.filter((x) => !after.includes(x));
        const add = after.filter((x) => !before.includes(x));
        await pve.put("/pools", { poolid: r.poolid, comment: v.comment });
        if (add.length) await pve.put("/pools", { poolid: r.poolid, vms: add.join(",") });
        if (rm.length) await pve.put("/pools", { poolid: r.poolid, vms: rm.join(","), delete: 1 });
      }}
      remove={(r) => pve.del("/pools", { poolid: s(r.poolid) })} createLabel="Novo pool" />
  );
}

// ---------- disponibilidade ----------

function HA() {
  const { data: guests } = useGuests();
  const { data: status } = useStatus();
  const { data: st } = useQuery({ queryKey: ["ha-status"], queryFn: () => pve.get<R[]>("/cluster/ha/status/current"), refetchInterval: 10_000 });
  const nodes = (status?.nodes ?? []).map((n) => n.name);
  const guestOpts: [string, string][] = (guests ?? []).filter((g) => !g.template).map((g) => [`${g.type === "qemu" ? "vm" : "ct"}:${g.vmid}`, `${g.vmid} ${g.name}`]);
  return (
    <>
      <section className="crud">
        <div className="section-head"><div><h2>Alta disponibilidade</h2><p>Se um nó cair, o Proxmox liga os guests com HA em outro nó. Precisa de 3 nós (ou QDevice) e storage compartilhado ou replicação.</p></div></div>
        <div className="svc-grid">
          {(st ?? []).filter((x) => x.type !== "service").map((x) => (
            <div key={s(x.id)} className="svc"><span className={`dot ${String(x.status).includes("active") || x.status === "OK" ? "running" : "paused"}`} /><span className="mono">{s(x.type)}</span><span className="muted">{s(x.status)}</span></div>
          ))}
        </div>
      </section>
      <CrudSection<R> title="Guests com HA" queryKey={["ha-resources"]} list={() => pve.get<R[]>("/cluster/ha/resources")} idOf={(r) => s(r.sid)}
        columns={[{ label: "Guest", render: (r) => s(r.sid), mono: true }, { label: "Estado pedido", render: (r) => s(r.state) }, { label: "Agora", render: (r) => s((st ?? []).find((x) => x.sid === r.sid)?.status) || "—" }, { label: "Comentário", render: (r) => s(r.comment) }]}
        fields={[
          { key: "sid", label: "Guest", type: "select", fixed: true, options: [["", "Escolha…"], ...guestOpts] },
          { key: "state", label: "Estado", type: "select", options: [["started", "Ligado"], ["stopped", "Desligado"], ["ignored", "Ignorado (sem HA)"], ["disabled", "Desativado"]] },
          { key: "max_restart", label: "Tentativas de religar no mesmo nó", type: "number" },
          { key: "max_relocate", label: "Tentativas de mudar de nó", type: "number" },
          { key: "comment", label: "Comentário", wide: true },
        ]}
        create={(v) => pve.post("/cluster/ha/resources", clean(v))}
        update={(r, v) => { const b = clean(v); delete b.sid; return pve.put(`/cluster/ha/resources/${enc(s(r.sid))}`, b); }}
        remove={(r) => pve.del(`/cluster/ha/resources/${enc(s(r.sid))}`)} createLabel="Adicionar guest ao HA" />
      <CrudSection<R> title="Regras de HA" help="Preferência de nó (node-affinity) ou manter guests juntos/separados (resource-affinity). No Proxmox 8 isso era 'grupos de HA'."
        queryKey={["ha-rules"]} list={() => pve.get<R[]>("/cluster/ha/rules").catch(() => [])} idOf={(r) => s(r.rule)}
        columns={[{ label: "Regra", render: (r) => s(r.rule), mono: true }, { label: "Tipo", render: (r) => s(r.type) }, { label: "Guests", render: (r) => s(r.resources) }, { label: "Nós", render: (r) => s(r.nodes) || s(r.affinity) }]}
        fields={[
          { key: "rule", label: "Nome", required: true, fixed: true },
          { key: "type", label: "Tipo", type: "select", fixed: true, options: [["node-affinity", "Preferir nós"], ["resource-affinity", "Juntos ou separados"]] },
          { key: "resources", label: "Guests", type: "multi", options: guestOpts },
          { key: "nodes", label: "Nós preferidos", type: "multi", options: nodes.map((n) => [n, n]), show: (v) => v.type === "node-affinity" },
          { key: "strict", label: "Só nesses nós (estrito)", type: "checkbox", show: (v) => v.type === "node-affinity" },
          { key: "affinity", label: "Os guests ficam", type: "select", options: [["positive", "juntos"], ["negative", "separados"]], show: (v) => v.type === "resource-affinity" },
          { key: "comment", label: "Comentário", wide: true },
        ]}
        toForm={(r) => ({ ...r, resources: s(r.resources).split(","), nodes: s(r.nodes).split(",").map((x) => x.split(":")[0]).filter(Boolean), strict: yes(r.strict) } as Values)}
        create={(v) => pve.post("/cluster/ha/rules", clean(v, { joinMulti: "," }))}
        update={(r, v) => { const b = clean(v, { joinMulti: "," }); delete b.rule; b.type = r.type; return pve.put(`/cluster/ha/rules/${enc(s(r.rule))}`, b); }}
        remove={(r) => pve.del(`/cluster/ha/rules/${enc(s(r.rule))}`)} createLabel="Nova regra" />
    </>
  );
}

function Replication() {
  const { data: guests } = useGuests();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).map((n) => n.name);
  return (
    <CrudSection<R> title="Replicação" help="Copia os discos ZFS de um guest pra outro nó de tempos em tempos. Junto com HA, deixa o guest subir em outro nó quase sem perda."
      queryKey={["replication"]} list={() => pve.get<R[]>("/cluster/replication")} idOf={(r) => s(r.id)}
      columns={[{ label: "Job", render: (r) => s(r.id), mono: true }, { label: "Guest", render: (r) => s(r.guest) }, { label: "De → para", render: (r) => `${s(r.source)} → ${s(r.target)}` }, { label: "Quando", render: (r) => s(r.schedule) || "*/15" }, { label: "Ativo", render: (r) => (yes(r.disable) ? "não" : "sim") }]}
      fields={[
        { key: "guest", label: "Guest", type: "select", fixed: true, options: [["", "Escolha…"], ...(guests ?? []).map((g) => [String(g.vmid), `${g.vmid} ${g.name} (${g.node})`] as [string, string])] },
        { key: "target", label: "Copiar para o nó", type: "select", fixed: true, options: nodes.map((n) => [n, n]) },
        { key: "schedule", label: "Quando", placeholder: "*/15 (a cada 15 min)" },
        { key: "rate", label: "Limite (MB/s)", type: "number" },
        { key: "comment", label: "Comentário", wide: true },
        { key: "disable", label: "Desativado", type: "checkbox" },
      ]}
      toForm={(r) => ({ ...r, guest: s(r.guest), disable: yes(r.disable) } as Values)}
      create={async (v) => {
        // O ID é <guest>-<número do job>: acha o próximo número livre.
        const jobs = await pve.get<R[]>("/cluster/replication");
        const used = jobs.filter((j) => s(j.guest) === v.guest || s(j.id).startsWith(`${v.guest}-`)).map((j) => Number(s(j.id).split("-")[1]));
        let n = 0;
        while (used.includes(n)) n++;
        return pve.post("/cluster/replication", clean({ id: `${v.guest}-${n}`, type: "local", target: v.target, schedule: v.schedule, rate: v.rate, comment: v.comment, disable: v.disable }));
      }}
      update={(r, v) => pve.put(`/cluster/replication/${enc(s(r.id))}`, clean({ schedule: v.schedule, rate: v.rate, comment: v.comment, disable: v.disable }))}
      remove={(r) => pve.del(`/cluster/replication/${enc(s(r.id))}`)}
      rowActions={(r) => <TaskButton label="Rodar agora" run={() => pve.post(`/nodes/${enc(s(r.source))}/replication/${enc(s(r.id))}/schedule_now`)} />}
      createLabel="Nova replicação" />
  );
}

// ---------- rede ----------

function SDN() {
  return (
    <>
      <section className="crud">
        <div className="section-head">
          <div><h2>SDN</h2><p>Redes virtuais do datacenter: zonas (VLAN, VXLAN, simples) e VNets que aparecem como bridges em todos os nós.</p></div>
          <TaskButton label="Aplicar mudanças" small={false} run={() => pve.put("/cluster/sdn")} />
        </div>
      </section>
      <CrudSection<R> title="Zonas" queryKey={["sdn-zones"]} list={() => pve.get<R[]>("/cluster/sdn/zones")} idOf={(r) => s(r.zone)}
        columns={[{ label: "Zona", render: (r) => s(r.zone), mono: true }, { label: "Tipo", render: (r) => s(r.type) }, { label: "Bridge / pares", render: (r) => s(r.bridge || r.peers) }, { label: "Estado", render: (r) => s(r.state) || "aplicada" }]}
        fields={[
          { key: "zone", label: "Nome (até 8 letras)", required: true, fixed: true },
          { key: "type", label: "Tipo", type: "select", fixed: true, options: [["simple", "Simples (rede isolada no nó)"], ["vlan", "VLAN"], ["qinq", "QinQ"], ["vxlan", "VXLAN (entre nós)"], ["evpn", "EVPN"]] },
          { key: "bridge", label: "Bridge", placeholder: "vmbr0", show: (v) => ["vlan", "qinq"].includes(String(v.type)) },
          { key: "tag", label: "Tag de serviço", type: "number", show: (v) => v.type === "qinq" },
          { key: "peers", label: "Pares (IPs dos nós)", placeholder: "10.0.10.11,10.0.10.12", show: (v) => v.type === "vxlan", wide: true },
          { key: "mtu", label: "MTU", type: "number" },
          { key: "ipam", label: "IPAM", placeholder: "pve" },
          { key: "dhcp", label: "DHCP automático", type: "select", options: [["", "nenhum"], ["dnsmasq", "dnsmasq"]], show: (v) => v.type === "simple" },
        ]}
        create={(v) => pve.post("/cluster/sdn/zones", clean(v))}
        update={(r, v) => { const b = clean(v); delete b.zone; delete b.type; return pve.put(`/cluster/sdn/zones/${enc(s(r.zone))}`, b); }}
        remove={(r) => pve.del(`/cluster/sdn/zones/${enc(s(r.zone))}`)} createLabel="Nova zona" />
      <VNets />
    </>
  );
}

function VNets() {
  const { data: zones } = useQuery({ queryKey: ["sdn-zones"], queryFn: () => pve.get<R[]>("/cluster/sdn/zones") });
  const [subnetsOf, setSubnetsOf] = useState<string | null>(null);
  return (
    <>
      <CrudSection<R> title="VNets" queryKey={["sdn-vnets"]} list={() => pve.get<R[]>("/cluster/sdn/vnets")} idOf={(r) => s(r.vnet)}
        columns={[{ label: "VNet", render: (r) => s(r.vnet), mono: true }, { label: "Zona", render: (r) => s(r.zone) }, { label: "Tag", render: (r) => s(r.tag) || "—" }, { label: "Apelido", render: (r) => s(r.alias) }]}
        fields={[
          { key: "vnet", label: "Nome (até 8 letras)", required: true, fixed: true },
          { key: "zone", label: "Zona", type: "select", options: [["", "Escolha…"], ...(zones ?? []).map((z) => [s(z.zone), s(z.zone)] as [string, string])] },
          { key: "tag", label: "Tag (VLAN/VNI)", type: "number" },
          { key: "alias", label: "Apelido" },
          { key: "vlanaware", label: "VLAN aware", type: "checkbox" },
        ]}
        create={(v) => pve.post("/cluster/sdn/vnets", clean(v))}
        update={(r, v) => { const b = clean(v); delete b.vnet; return pve.put(`/cluster/sdn/vnets/${enc(s(r.vnet))}`, b); }}
        remove={(r) => pve.del(`/cluster/sdn/vnets/${enc(s(r.vnet))}`)}
        rowActions={(r) => <button className="btn small" onClick={() => setSubnetsOf(s(r.vnet))}>Sub-redes</button>}
        createLabel="Nova VNet" />
      {subnetsOf && (
        <Modal label="Sub-redes" onClose={() => setSubnetsOf(null)} className="wide">
          <button className="close" onClick={() => setSubnetsOf(null)} aria-label="Fechar"><IconX /></button>
          <CrudSection<R> title={`Sub-redes de ${subnetsOf}`} queryKey={["sdn-subnets", subnetsOf]} list={() => pve.get<R[]>(`/cluster/sdn/vnets/${enc(subnetsOf)}/subnets`)} idOf={(r) => s(r.subnet)}
            columns={[{ label: "Sub-rede", render: (r) => s(r.cidr || r.subnet), mono: true }, { label: "Gateway", render: (r) => s(r.gateway), mono: true }, { label: "SNAT", render: (r) => (yes(r.snat) ? "sim" : "não") }]}
            fields={[{ key: "subnet", label: "CIDR", required: true, fixed: true, placeholder: "10.10.0.0/24" }, { key: "gateway", label: "Gateway", placeholder: "10.10.0.1" }, { key: "snat", label: "SNAT (sair pra internet pelo nó)", type: "checkbox" }]}
            create={(v) => pve.post(`/cluster/sdn/vnets/${enc(subnetsOf)}/subnets`, clean({ ...v, type: "subnet" }))}
            remove={(r) => pve.del(`/cluster/sdn/vnets/${enc(subnetsOf)}/subnets/${enc(s(r.subnet))}`)} createLabel="Nova sub-rede" />
        </Modal>
      )}
    </>
  );
}

function FwGroups() {
  const [rulesOf, setRulesOf] = useState<string | null>(null);
  return (
    <>
      <CrudSection<R> title="Grupos de segurança" help="Conjuntos de regras reaproveitáveis (ex.: 'webserver' com HTTP e HTTPS) que você aplica em vários guests."
        queryKey={["fw-groups"]} list={() => pve.get<R[]>("/cluster/firewall/groups")} idOf={(r) => s(r.group)}
        columns={[{ label: "Grupo", render: (r) => s(r.group), mono: true }, { label: "Comentário", render: (r) => s(r.comment) }]}
        fields={[{ key: "group", label: "Nome", required: true, fixed: true }, { key: "comment", label: "Comentário", wide: true }]}
        create={(v) => pve.post("/cluster/firewall/groups", clean(v))}
        remove={(r) => pve.del(`/cluster/firewall/groups/${enc(s(r.group))}`)}
        rowActions={(r) => <button className="btn small" onClick={() => setRulesOf(s(r.group))}>Regras</button>}
        createLabel="Novo grupo" />
      {rulesOf && (
        <Modal label="Regras" onClose={() => setRulesOf(null)} className="wide xl">
          <button className="close" onClick={() => setRulesOf(null)} aria-label="Fechar"><IconX /></button>
          <CrudSection<R> title={`Regras do grupo ${rulesOf}`} queryKey={["fw-group", rulesOf]} list={() => pve.get<R[]>(`/cluster/firewall/groups/${enc(rulesOf)}`)} idOf={(r) => s(r.pos)}
            columns={[{ label: "#", render: (r) => s(r.pos), mono: true }, { label: "Direção", render: (r) => (r.type === "out" ? "saída" : "entrada") }, { label: "Ação", render: (r) => s(r.action) }, { label: "Serviço/porta", render: (r) => s(r.macro) || `${s(r.proto)} ${s(r.dport)}`, mono: true }, { label: "Origem", render: (r) => s(r.source) || "qualquer", mono: true }]}
            fields={[
              { key: "type", label: "Direção", type: "select", options: [["in", "Entrada"], ["out", "Saída"]] },
              { key: "action", label: "Ação", type: "select", options: [["ACCEPT", "ACCEPT"], ["DROP", "DROP"], ["REJECT", "REJECT"]] },
              { key: "macro", label: "Serviço pronto", placeholder: "HTTPS, SSH… (ou deixe vazio)" },
              { key: "proto", label: "Protocolo", placeholder: "tcp" },
              { key: "dport", label: "Porta(s)", placeholder: "443" },
              { key: "source", label: "Origem", placeholder: "qualquer" },
              { key: "comment", label: "Comentário", wide: true },
              { key: "enable", label: "Ativa", type: "checkbox" },
            ]}
            create={(v) => pve.post(`/cluster/firewall/groups/${enc(rulesOf)}`, clean({ type: "in", action: "ACCEPT", ...v }))}
            remove={(r) => pve.del(`/cluster/firewall/groups/${enc(rulesOf)}/${s(r.pos)}`)} createLabel="Nova regra" />
        </Modal>
      )}
    </>
  );
}

function FwAliases() {
  const [setOf, setSetOf] = useState<string | null>(null);
  return (
    <>
      <CrudSection<R> title="Aliases" help="Nomes pra IPs e redes, usados nas regras (ex.: 'lan' = 10.0.10.0/24)." queryKey={["fw-aliases"]}
        list={() => pve.get<R[]>("/cluster/firewall/aliases")} idOf={(r) => s(r.name)}
        columns={[{ label: "Nome", render: (r) => s(r.name), mono: true }, { label: "Endereço", render: (r) => s(r.cidr), mono: true }, { label: "Comentário", render: (r) => s(r.comment) }]}
        fields={[{ key: "name", label: "Nome", required: true, fixed: true }, { key: "cidr", label: "IP ou rede", required: true, placeholder: "10.0.10.0/24" }, { key: "comment", label: "Comentário", wide: true }]}
        create={(v) => pve.post("/cluster/firewall/aliases", clean(v))}
        update={(r, v) => pve.put(`/cluster/firewall/aliases/${enc(s(r.name))}`, { cidr: v.cidr, comment: v.comment })}
        remove={(r) => pve.del(`/cluster/firewall/aliases/${enc(s(r.name))}`)} createLabel="Novo alias" />
      <CrudSection<R> title="IPSets" help="Listas de endereços. O IPSet 'management' libera o acesso ao painel e SSH mesmo com tudo bloqueado."
        queryKey={["fw-ipsets"]} list={() => pve.get<R[]>("/cluster/firewall/ipset")} idOf={(r) => s(r.name)}
        columns={[{ label: "Nome", render: (r) => s(r.name), mono: true }, { label: "Comentário", render: (r) => s(r.comment) }]}
        fields={[{ key: "name", label: "Nome", required: true, fixed: true }, { key: "comment", label: "Comentário", wide: true }]}
        create={(v) => pve.post("/cluster/firewall/ipset", clean(v))}
        remove={(r) => pve.del(`/cluster/firewall/ipset/${enc(s(r.name))}`)}
        rowActions={(r) => <button className="btn small" onClick={() => setSetOf(s(r.name))}>Endereços</button>}
        createLabel="Novo IPSet" />
      {setOf && (
        <Modal label="Endereços" onClose={() => setSetOf(null)} className="wide">
          <button className="close" onClick={() => setSetOf(null)} aria-label="Fechar"><IconX /></button>
          <CrudSection<R> title={`Endereços de ${setOf}`} queryKey={["fw-ipset", setOf]} list={() => pve.get<R[]>(`/cluster/firewall/ipset/${enc(setOf)}`)} idOf={(r) => s(r.cidr)}
            columns={[{ label: "Endereço", render: (r) => `${yes(r.nomatch) ? "! " : ""}${s(r.cidr)}`, mono: true }, { label: "Comentário", render: (r) => s(r.comment) }]}
            fields={[{ key: "cidr", label: "IP ou rede", required: true, placeholder: "10.0.10.0/24" }, { key: "comment", label: "Comentário" }, { key: "nomatch", label: "Exceção (não casa)", type: "checkbox" }]}
            create={(v) => pve.post(`/cluster/firewall/ipset/${enc(setOf)}`, clean(v))}
            remove={(r) => pve.del(`/cluster/firewall/ipset/${enc(setOf)}/${enc(s(r.cidr))}`)} createLabel="Adicionar endereço" />
        </Modal>
      )}
    </>
  );
}

// ---------- integrações ----------

const b64 = (x: string) => btoa(unescape(encodeURIComponent(x)));

// Webhooks prontos: o Proxmox manda {{ title }} e {{ message }} no corpo.
const WEBHOOK_PRESETS: Record<string, { label: string; url: string; body: string; headers?: string[]; help: string }> = {
  telegram: { label: "Telegram", url: "https://api.telegram.org/bot<TOKEN>/sendMessage", body: '{"chat_id": "<CHAT_ID>", "text": "{{ title }}\\n\\n{{ message }}"}', headers: ["Content-Type: application/json"], help: "Crie o bot com o @BotFather e pegue o chat_id com @userinfobot." },
  discord: { label: "Discord", url: "https://discord.com/api/webhooks/<ID>/<TOKEN>", body: '{"content": "**{{ title }}**\\n{{ message }}"}', headers: ["Content-Type: application/json"], help: "Canal → Integrações → Webhooks → Copiar URL." },
  ntfy: { label: "ntfy", url: "https://ntfy.sh/<SEU_TOPICO>", body: "{{ message }}", headers: ["Title: {{ title }}"], help: "Instale o app ntfy e assine o mesmo tópico." },
};

function Notifications() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<"" | "telegram" | "discord" | "ntfy" | "smtp" | "gotify">("");
  const { data: targets } = useQuery({ queryKey: ["notif-targets"], queryFn: () => pve.get<R[]>("/cluster/notifications/targets") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["notif-targets"] }); qc.invalidateQueries({ queryKey: ["notif-matchers"] }); };
  const kindOf = (name: string) => s((targets ?? []).find((t) => t.name === name)?.type);
  return (
    <>
      <section className="crud">
        <div className="section-head">
          <div><h2>Notificações</h2><p>O próprio Proxmox avisa quando backup falha, disco dá problema, atualização sai… Aqui você escolhe pra onde vai.</p></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["telegram", "discord", "ntfy"] as const).map((k) => <button key={k} className="btn small" onClick={() => setAdding(k)}>+ {WEBHOOK_PRESETS[k].label}</button>)}
            <button className="btn small" onClick={() => setAdding("smtp")}>+ E-mail (SMTP)</button>
            <button className="btn small" onClick={() => setAdding("gotify")}>+ Gotify</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Destino</th><th>Tipo</th><th>Comentário</th><th /></tr></thead>
            <tbody>
              {(targets ?? []).map((t) => (
                <tr key={s(t.name)} style={{ cursor: "default" }}>
                  <td className="mono">{s(t.name)}</td><td>{s(t.type)}</td><td>{s(t.comment)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <TaskButton label="Testar" run={() => pve.post(`/cluster/notifications/targets/${enc(s(t.name))}/test`)} />{" "}
                    {t.origin !== "builtin" && <TaskButton label="Apagar" danger confirm="Confirmar" run={() => pve.del(`/cluster/notifications/endpoints/${kindOf(s(t.name))}/${enc(s(t.name))}`)} onDone={refresh} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <CrudSection<R> title="Regras (o que vai pra onde)" help="Sem regra, nada é enviado pro destino novo. Ex.: tudo com gravidade 'error' vai pro Telegram."
        queryKey={["notif-matchers"]} list={() => pve.get<R[]>("/cluster/notifications/matchers")} idOf={(r) => s(r.name)}
        columns={[{ label: "Regra", render: (r) => s(r.name), mono: true }, { label: "Gravidade", render: (r) => s(r["match-severity"]) || "todas" }, { label: "Destinos", render: (r) => [r.target].flat().join(", ") }, { label: "Comentário", render: (r) => s(r.comment) }]}
        fields={[
          { key: "name", label: "Nome", required: true, fixed: true },
          { key: "severity", label: "Gravidade", type: "multi", options: [["error", "erro"], ["warning", "aviso"], ["notice", "notícia"], ["info", "info"], ["unknown", "outras"]] },
          { key: "target", label: "Mandar para", type: "multi", options: (targets ?? []).map((t) => [s(t.name), s(t.name)]) },
          { key: "comment", label: "Comentário", wide: true },
        ]}
        toForm={(r) => ({ name: s(r.name), comment: s(r.comment), target: [r.target].flat().filter(Boolean).map(String), severity: s(r["match-severity"]).replace("severity:", "").split(",").filter(Boolean) })}
        create={(v) => pve.post("/cluster/notifications/matchers", clean({ name: v.name, comment: v.comment, target: v.target, "match-severity": (v.severity as string[]).length ? (v.severity as string[]).join(",") : undefined }))}
        update={(r, v) => pve.put(`/cluster/notifications/matchers/${enc(s(r.name))}`, clean({ comment: v.comment, target: v.target, "match-severity": (v.severity as string[]).join(",") }))}
        remove={(r) => pve.del(`/cluster/notifications/matchers/${enc(s(r.name))}`)} createLabel="Nova regra" />
      {adding && (
        <Modal label="Novo destino" onClose={() => setAdding("")} className="wide">
          <button className="close" onClick={() => setAdding("")} aria-label="Fechar"><IconX /></button>
          <h2>Novo destino · {adding === "smtp" ? "E-mail" : adding === "gotify" ? "Gotify" : WEBHOOK_PRESETS[adding].label}</h2>
          {adding in WEBHOOK_PRESETS && <p className="muted" style={{ fontSize: 13 }}>{WEBHOOK_PRESETS[adding as "telegram"].help}</p>}
          <SpecForm
            initial={adding in WEBHOOK_PRESETS ? { name: adding, url: WEBHOOK_PRESETS[adding as "telegram"].url, body: WEBHOOK_PRESETS[adding as "telegram"].body, also: true } : { name: adding, mode: "starttls", port: 587, also: true }}
            fields={adding === "smtp" ? [
              { key: "name", label: "Nome", required: true }, { key: "server", label: "Servidor", required: true, placeholder: "smtp.gmail.com" },
              { key: "port", label: "Porta", type: "number" }, { key: "mode", label: "Segurança", type: "select", options: [["starttls", "STARTTLS"], ["tls", "TLS"], ["insecure", "nenhuma"]] },
              { key: "username", label: "Usuário" }, { key: "password", label: "Senha", type: "password" },
              { key: "from-address", label: "Remetente", required: true, placeholder: "pve@seudominio" }, { key: "mailto", label: "Mandar para", required: true, placeholder: "voce@email.com" },
              { key: "also", label: "Já criar regra mandando erros e avisos pra cá", type: "checkbox" },
            ] : adding === "gotify" ? [
              { key: "name", label: "Nome", required: true }, { key: "server", label: "Servidor", required: true, placeholder: "https://gotify.casa.lan" },
              { key: "token", label: "Token do app", type: "password", required: true },
              { key: "also", label: "Já criar regra mandando erros e avisos pra cá", type: "checkbox" },
            ] : [
              { key: "name", label: "Nome", required: true }, { key: "url", label: "URL", required: true, wide: true },
              { key: "body", label: "Corpo", type: "textarea" },
              { key: "also", label: "Já criar regra mandando erros e avisos pra cá", type: "checkbox" },
            ]}
            submitLabel="Criar"
            onCancel={() => setAdding("")}
            onSubmit={async (v) => {
              const name = String(v.name);
              if (adding === "smtp") {
                await pve.post("/cluster/notifications/endpoints/smtp", clean({ name, server: v.server, port: v.port, mode: v.mode, username: v.username, password: v.password, "from-address": v["from-address"], mailto: v.mailto }));
              } else if (adding === "gotify") {
                await pve.post("/cluster/notifications/endpoints/gotify", clean({ name, server: v.server, token: v.token }));
              } else {
                const p = WEBHOOK_PRESETS[adding];
                await pve.post("/cluster/notifications/endpoints/webhook", {
                  name, url: v.url, method: "post", body: b64(String(v.body)),
                  header: (p.headers ?? []).map((h) => { const [k, ...rest] = h.split(": "); return `name=${k},value=${b64(rest.join(": "))}`; }),
                });
              }
              if (v.also) await pve.post("/cluster/notifications/matchers", { name: `mia-${name}`, target: name, "match-severity": "error,warning", comment: "Criada pela Mia" });
              setAdding("");
              refresh();
            }} />
        </Modal>
      )}
    </>
  );
}

function Acme() {
  const { data: dirs } = useQuery({ queryKey: ["acme-dirs"], queryFn: () => pve.get<{ name: string; url: string }[]>("/cluster/acme/directories") });
  const { data: schema } = useQuery({ queryKey: ["acme-schema"], queryFn: () => pve.get<{ id: string; name: string; type: string }[]>("/cluster/acme/challenge-schema") });
  return (
    <>
      <CrudSection<R> title="Contas ACME" help="Conta no Let's Encrypt pra emitir certificado de verdade pros nós (e pra Mia, que usa o mesmo)."
        queryKey={["acme-accounts"]} list={() => pve.get<R[]>("/cluster/acme/account")} idOf={(r) => s(r.name)}
        columns={[{ label: "Conta", render: (r) => s(r.name), mono: true }]}
        fields={[
          { key: "name", label: "Nome", required: true, fixed: true, placeholder: "default" },
          { key: "contact", label: "E-mail", required: true },
          { key: "directory", label: "Servidor", type: "select", options: (dirs ?? []).map((d) => [d.url, d.name]) },
          { key: "tos", label: "Aceito os termos do Let's Encrypt", type: "checkbox" },
        ]}
        create={async (v) => {
          const tos = await pve.get<string>("/cluster/acme/tos", { directory: String(v.directory || dirs?.[0]?.url) });
          if (!v.tos) throw new Error("Aceite os termos de uso");
          return pve.post("/cluster/acme/account", clean({ name: v.name, contact: v.contact, directory: v.directory || dirs?.[0]?.url, tos_url: tos }));
        }}
        remove={(r) => pve.del(`/cluster/acme/account/${enc(s(r.name))}`)} createLabel="Nova conta" />
      <CrudSection<R> title="Plugins de DNS" help="Pra validar por DNS (Cloudflare, DuckDNS…), sem abrir a porta 80. Os dados de acesso vão no formato CHAVE=valor, um por linha."
        queryKey={["acme-plugins"]} list={() => pve.get<R[]>("/cluster/acme/plugins")} idOf={(r) => s(r.plugin)}
        columns={[{ label: "Plugin", render: (r) => s(r.plugin), mono: true }, { label: "API", render: (r) => s(r.api) }]}
        fields={[
          { key: "id", label: "Nome", required: true, fixed: true, placeholder: "cloudflare" },
          { key: "api", label: "Provedor", type: "select", options: (schema ?? []).filter((x) => x.type === "dns").map((x) => [x.id, x.name]) },
          { key: "data", label: "Dados de acesso", type: "textarea", placeholder: "CF_Token=…\nCF_Account_ID=…" },
        ]}
        create={(v) => pve.post("/cluster/acme/plugins", { id: v.id, type: "dns", api: v.api, data: b64(String(v.data)) })}
        remove={(r) => pve.del(`/cluster/acme/plugins/${enc(s(r.plugin))}`)} createLabel="Novo plugin" />
    </>
  );
}

function Mappings() {
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).map((n) => n.name);
  const kinds: [string, string, string][] = [["pci", "PCI (placa de vídeo, rede…)", "node=pve-01,path=0000:01:00"], ["usb", "USB", "node=pve-01,id=1a86:55d4"], ["dir", "Pastas (virtiofs)", "node=pve-01,path=/tank/media"]];
  return (
    <>
      {kinds.map(([k, label, example]) => (
        <CrudSection<R> key={k} title={`Mapeamento ${label}`} help={`Dá um nome a um dispositivo em cada nó, pra usar em VMs e migrar entre nós. Formato por nó: ${example}`}
          queryKey={["mapping", k]} list={() => pve.get<R[]>(`/cluster/mapping/${k}`)} idOf={(r) => s(r.id)}
          columns={[{ label: "Nome", render: (r) => s(r.id), mono: true }, { label: "Nos nós", render: (r) => [r.map].flat().map(String).join("; "), mono: true }, { label: "Descrição", render: (r) => s(r.description) }]}
          fields={[
            { key: "id", label: "Nome", required: true, fixed: true },
            { key: "description", label: "Descrição", wide: true },
            ...nodes.map((n) => ({ key: `map_${n}`, label: `Em ${n}`, placeholder: example.replace("pve-01", n).replace(/^node=[^,]+,/, ""), wide: true })),
          ]}
          toForm={(r) => {
            const out: Values = { id: s(r.id), description: s(r.description) };
            for (const m of [r.map].flat().map(String)) { const n = m.match(/node=([^,]+)/)?.[1]; if (n) out[`map_${n}`] = m.replace(/node=[^,]+,?/, ""); }
            return out;
          }}
          create={(v) => pve.post(`/cluster/mapping/${k}`, { id: v.id, description: v.description, map: nodes.filter((n) => v[`map_${n}`]).map((n) => `node=${n},${v[`map_${n}`]}`) })}
          update={(r, v) => pve.put(`/cluster/mapping/${k}/${enc(s(r.id))}`, { description: v.description, map: nodes.filter((n) => v[`map_${n}`]).map((n) => `node=${n},${v[`map_${n}`]}`) })}
          remove={(r) => pve.del(`/cluster/mapping/${k}/${enc(s(r.id))}`)} createLabel="Novo mapeamento" />
      ))}
    </>
  );
}

function Metrics() {
  return (
    <CrudSection<R> title="Servidores de métricas" help="Manda as métricas do Proxmox pra InfluxDB ou Graphite (pra ver no Grafana, por exemplo)."
      queryKey={["metrics"]} list={() => pve.get<R[]>("/cluster/metrics/server")} idOf={(r) => s(r.id)}
      columns={[{ label: "Nome", render: (r) => s(r.id), mono: true }, { label: "Tipo", render: (r) => s(r.type) }, { label: "Servidor", render: (r) => `${s(r.server)}:${s(r.port)}`, mono: true }, { label: "Ativo", render: (r) => (yes(r.disable) ? "não" : "sim") }]}
      fields={[
        { key: "id", label: "Nome", required: true, fixed: true },
        { key: "type", label: "Tipo", type: "select", fixed: true, options: [["influxdb", "InfluxDB"], ["graphite", "Graphite"]] },
        { key: "server", label: "Servidor", required: true }, { key: "port", label: "Porta", type: "number", required: true },
        { key: "influxdbproto", label: "Protocolo", type: "select", options: [["udp", "UDP"], ["http", "HTTP"], ["https", "HTTPS"]], show: (v) => v.type === "influxdb" },
        { key: "organization", label: "Organização", show: (v) => v.type === "influxdb" }, { key: "bucket", label: "Bucket", show: (v) => v.type === "influxdb" },
        { key: "token", label: "Token", type: "password", show: (v) => v.type === "influxdb" },
        { key: "path", label: "Prefixo", show: (v) => v.type === "graphite", placeholder: "proxmox" },
        { key: "disable", label: "Desativado", type: "checkbox" },
      ]}
      toForm={(r) => ({ ...r, disable: yes(r.disable) } as Values)}
      create={(v) => { const b = clean(v); delete b.id; return pve.post(`/cluster/metrics/server/${enc(String(v.id))}`, b); }}
      update={(r, v) => { const b = clean(v); delete b.id; delete b.type; return pve.put(`/cluster/metrics/server/${enc(s(r.id))}`, b); }}
      remove={(r) => pve.del(`/cluster/metrics/server/${enc(s(r.id))}`)} createLabel="Novo servidor" />
  );
}

// ---------- Ceph ----------

function Ceph() {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).filter((n) => n.online).map((n) => n.name);
  const [picked, setNode] = useState("");
  const node = picked || nodes[0] || "";
  const { data, error } = useQuery({ queryKey: ["ceph-status"], queryFn: () => pve.get<R>("/cluster/ceph/status"), retry: false });
  const health = data?.health as R | undefined;
  const notInstalled = !!error && /not installed|binary/i.test((error as Error).message);
  return (
    <section className="crud">
      <div className="section-head">
        <div><h2>Ceph</h2><p>Storage distribuído entre os nós. Faz sentido com 3+ nós e rede de 10 Gbit.</p></div>
        <select className="scope-select" value={node} onChange={(e) => setNode(e.target.value)} aria-label="Nó">{nodes.map((n) => <option key={n}>{n}</option>)}</select>
      </div>
      {notInstalled ? (
        <>
          <div className="warn">O Ceph não está instalado em {node}. ({(error as Error).message})</div>
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => ui.openConsole({ node, kind: "node", cmd: "ceph_install", title: `Instalando Ceph em ${node}` })}>
              Instalar Ceph em {node}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Abre o assistente de instalação do Proxmox no console. Repita em cada nó; depois volte aqui pra inicializar.</p>
        </>
      ) : error ? (
        <>
          <div className="warn">O Ceph está instalado mas ainda não foi inicializado. ({(error as Error).message})</div>
          <SpecForm submitLabel="Inicializar o Ceph" initial={{ size: 3, min_size: 2 }} fields={[
            { key: "network", label: "Rede pública do Ceph", required: true, placeholder: "10.0.20.0/24" },
            { key: "cluster-network", label: "Rede de replicação (opcional)", placeholder: "10.0.30.0/24" },
            { key: "size", label: "Cópias de cada dado", type: "number" },
            { key: "min_size", label: "Mínimo pra continuar gravando", type: "number" },
          ]} onSubmit={async (v) => { await pve.post(`/nodes/${enc(node)}/ceph/init`, clean(v)); qc.invalidateQueries({ queryKey: ["ceph-status"] }); }} />
        </>
      ) : data ? (
        <>
          <dl className="kv"><dt>Saúde</dt><dd>{s(health?.status)}</dd><dt>FSID</dt><dd className="mono">{s(data.fsid)}</dd></dl>
          <CephDaemons node={node} kind="mon" />
          <CephDaemons node={node} kind="mgr" />
          <CephOsds node={node} />
          <CephPools node={node} />
          <CephFS node={node} />
        </>
      ) : <p className="muted">Carregando…</p>}
    </section>
  );
}

function CephDaemons({ node, kind }: { node: string; kind: "mon" | "mgr" }) {
  const label = kind === "mon" ? "Monitores" : "Managers";
  return (
    <CrudSection<R> title={label} help={kind === "mon" ? "Guardam o mapa do cluster. Tenha 3 (um por nó)." : "Métricas e painel do Ceph. Um ativo e um reserva bastam."}
      queryKey={["ceph", kind, node]} list={() => pve.get<R[]>(`/nodes/${enc(node)}/ceph/${kind}`)} idOf={(r) => s(r.name)}
      columns={[{ label: "Nome", render: (r) => s(r.name), mono: true }, { label: "Nó", render: (r) => s(r.host) }, { label: "Endereço", render: (r) => s(r.addr), mono: true }, { label: "Estado", render: (r) => s(r.state ?? (r.quorum ? "quorum" : "")) }]}
      headerExtra={<TaskButton label={`Criar em ${node}`} run={() => pve.post(`/nodes/${enc(node)}/ceph/${kind}/${enc(node)}`)} />}
      remove={(r) => pve.del(`/nodes/${enc(s(r.host) || node)}/ceph/${kind}/${enc(s(r.name))}`)} />
  );
}

function CephOsds({ node }: { node: string }) {
  const { data: disks } = useQuery({ queryKey: ["disks", node], queryFn: () => pve.get<R[]>(`/nodes/${enc(node)}/disks/list`) });
  const free = (disks ?? []).filter((d) => !d.used || d.used === "unused");
  // O PVE devolve uma árvore (raiz → hosts → OSDs); a tabela quer só os OSDs.
  const flat = (t: R): R[] => [...(t.type === "osd" ? [t] : []), ...((t.children as R[] | undefined) ?? []).flatMap(flat)];
  return (
    <CrudSection<R> title="OSDs" help="Um OSD por disco. O disco é apagado ao virar OSD."
      queryKey={["ceph", "osd", node]} list={async () => flat((await pve.get<R>(`/nodes/${enc(node)}/ceph/osd`)).root as R ?? {})} idOf={(r) => s(r.id)}
      columns={[
        { label: "OSD", render: (r) => s(r.name), mono: true }, { label: "Nó", render: (r) => s(r.host) },
        { label: "Estado", render: (r) => `${s(r.status)} · ${yes(r.in) ? "in" : "out"}` }, { label: "Classe", render: (r) => s(r.device_class) },
        { label: "Uso", render: (r) => (r.percent_used !== undefined ? `${Number(r.percent_used).toFixed(1)}%` : "—") },
      ]}
      rowActions={(r, refresh) => yes(r.in)
        ? <TaskButton label="Tirar (out)" run={() => pve.post(`/nodes/${enc(s(r.host) || node)}/ceph/osd/${s(r.id)}/out`)} onDone={refresh} />
        : <TaskButton label="Pôr (in)" run={() => pve.post(`/nodes/${enc(s(r.host) || node)}/ceph/osd/${s(r.id)}/in`)} onDone={refresh} />}
      fields={[
        { key: "dev", label: "Disco", type: "select", required: true, options: [["", "Escolha…"], ...free.map((d): [string, string] => [s(d.devpath), `${s(d.devpath)} · ${s(d.model)} · ${bytes(Number(d.size))}`])] },
        { key: "crush-device-class", label: "Classe", type: "select", options: [["", "automática"], ["hdd", "hdd"], ["ssd", "ssd"], ["nvme", "nvme"]] },
        { key: "encrypted", label: "Criptografar", type: "checkbox" },
      ]}
      create={(v) => pve.post(`/nodes/${enc(node)}/ceph/osd`, clean(v))}
      remove={(r) => pve.del(`/nodes/${enc(s(r.host) || node)}/ceph/osd/${s(r.id)}`, { cleanup: 1 })} createLabel={`Novo OSD em ${node}`} />
  );
}

function CephFS({ node }: { node: string }) {
  return (
    <CrudSection<R> title="CephFS" help="Sistema de arquivos em cima do Ceph, pra ISOs, backups e pastas compartilhadas. Precisa de um servidor de metadados (MDS)."
      queryKey={["ceph", "fs", node]} list={() => pve.get<R[]>(`/nodes/${enc(node)}/ceph/fs`)} idOf={(r) => s(r.name)}
      columns={[{ label: "Nome", render: (r) => s(r.name), mono: true }, { label: "Dados", render: (r) => s(r.data_pool), mono: true }, { label: "Metadados", render: (r) => s(r.metadata_pool), mono: true }]}
      headerExtra={<TaskButton label={`Criar MDS em ${node}`} run={() => pve.post(`/nodes/${enc(node)}/ceph/mds/${enc(node)}`)} />}
      fields={[{ key: "name", label: "Nome", required: true, placeholder: "cephfs" }, { key: "add-storage", label: "Já criar storage no Proxmox", type: "checkbox" }]}
      create={(v) => pve.post(`/nodes/${enc(node)}/ceph/fs/${enc(String(v.name))}`, { "add-storage": v["add-storage"] ? 1 : 0 })} createLabel="Novo CephFS" />
  );
}

function CephPools({ node }: { node: string }) {
  return (
    <CrudSection<R> title="Pools do Ceph" queryKey={["ceph-pools", node]} list={() => pve.get<R[]>(`/nodes/${enc(node)}/ceph/pool`)} idOf={(r) => s(r.pool_name || r.name)}
      columns={[{ label: "Pool", render: (r) => s(r.pool_name || r.name), mono: true }, { label: "Cópias", render: (r) => `${s(r.size)}/${s(r.min_size)}` }, { label: "PGs", render: (r) => s(r.pg_num) }]}
      fields={[{ key: "name", label: "Nome", required: true }, { key: "size", label: "Cópias", type: "number" }, { key: "min_size", label: "Mínimo", type: "number" }, { key: "add_storages", label: "Já criar storage no Proxmox", type: "checkbox" }]}
      create={(v) => pve.post(`/nodes/${enc(node)}/ceph/pool`, clean(v))}
      remove={(r) => pve.del(`/nodes/${enc(node)}/ceph/pool/${enc(s(r.pool_name || r.name))}`, { remove_storages: 1 })} createLabel="Novo pool" />
  );
}

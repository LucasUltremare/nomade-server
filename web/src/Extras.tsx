import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type App, type Guest } from "./api";
import { SpecForm, clean, enc, pve, type Values } from "./Crud";
import { Modal } from "./Dialogs";
import { bytes } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useGuests, useSettings, useStatus, useUI } from "./state";

// Scripts que a Mia digita no console do nó. Tudo que não precisa de tela
// vai dentro de "bash <<'X'": assim um erro não fecha o shell do usuário.

const OWNERS: [string, string, string][] = [
  ["100000", "root dos contêineres", "chown 100000:100000"],
  ["101000", "usuário 1000 dos contêineres", "chown 101000:101000"],
  ["777", "todos podem escrever", "chmod 777"],
];

export function sharedFolderScript(path: string, mp: string, ids: number[], owner: string, ro: boolean) {
  const own = owner === "777" ? `chmod 0777 "$P"` : `chown ${owner}:${owner} "$P" && chmod 0775 "$P"`;
  return ` bash <<'MIA_SHARE'
P=${JSON.stringify(path)}; MP=${JSON.stringify(mp)}
mkdir -p "$P" && ${own} && echo "==> Pasta $P pronta"
for ID in ${ids.join(" ")}; do
  N=$(for i in $(seq 0 255); do pct config "$ID" | grep -q "^mp$i:" || { echo $i; break; }; done)
  if pct set "$ID" -mp$N "$P",mp="$MP"${ro ? ",ro=1" : ""}; then echo "==> CT $ID: $P em $MP (mp$N)"; else echo "!! CT $ID: falhou"; fi
done
echo "==> Pronto. Contêiner ligado pode precisar reiniciar pra ver a pasta."
MIA_SHARE`;
}

export function igpuScript(vmid: number) {
  return ` bash <<'MIA_GPU'
ID=${vmid}
if [ ! -e /dev/dri/renderD128 ]; then echo "!! Este nó não tem GPU em /dev/dri"; exit 0; fi
if [ "$(pct status $ID | awk '{print $2}')" = running ]; then
  R=$(pct exec $ID -- getent group render | cut -d: -f3); V=$(pct exec $ID -- getent group video | cut -d: -f3)
fi
free_dev() { for i in $(seq 0 63); do pct config "$ID" | grep -q "^dev$i:" || { echo $i; break; }; done; }
pct config "$ID" | grep -q "/dev/dri/renderD128" || pct set "$ID" -dev$(free_dev) /dev/dri/renderD128,gid=\${R:-104}
pct config "$ID" | grep -q "/dev/dri/card0" || pct set "$ID" -dev$(free_dev) /dev/dri/card0,gid=\${V:-44}
echo "==> GPU ligada no CT $ID (render=\${R:-104}, video=\${V:-44})"
pct reboot "$ID" && echo "==> CT reiniciado"
MIA_GPU`;
}

// ---------- pastas compartilhadas ----------

interface Shared { node: string; path: string; mounts: { vmid: number; name: string; key: string; mp: string; ro: boolean }[] }

export function SharedFolders() {
  const ui = useUI();
  const { data: settings } = useSettings();
  const { data, error } = useQuery({ queryKey: ["shared"], queryFn: async () => (await fetch("/api/shared-folders")).json() as Promise<Shared[]> });
  const [adding, setAdding] = useState<Partial<Shared> | null>(null);
  return (
    <section className="section">
      <div className="section-head">
        <div><h2>Pastas compartilhadas</h2><p>Uma pasta do nó montada em vários contêineres (ex.: /tank/media no Jellyfin, Sonarr e qBittorrent).</p></div>
        <button className="btn small primary" disabled={!settings?.root} title={settings?.root ? undefined : "Só root@pam"} onClick={() => setAdding({})}>Nova pasta compartilhada</button>
      </div>
      {error && <div className="err">{(error as Error).message}</div>}
      <div className="disk-list">
        {(data ?? []).map((f) => (
          <div key={f.node + f.path} className="disk">
            <div className="disk-main">
              <div><b className="mono">{f.path}</b><span className="muted"> · {f.node}</span></div>
              <div className="mono muted disk-vol">{f.mounts.map((m) => `${m.name} → ${m.mp}${m.ro ? " (só leitura)" : ""}`).join(" · ")}</div>
            </div>
            <div />
            <div className="disk-actions">
              <button className="btn small" disabled={!settings?.root} onClick={() => setAdding({ node: f.node, path: f.path, mounts: [] })}>Montar em mais</button>
            </div>
          </div>
        ))}
        {data && !data.length && <p className="muted" style={{ fontSize: 13 }}>Nenhuma pasta compartilhada ainda.</p>}
      </div>
      {adding && <ShareDialog initial={adding} onClose={() => setAdding(null)} onRun={(node, cmd) => { setAdding(null); ui.openConsole({ node, kind: "node", title: "Pasta compartilhada", autorun: cmd }); }} />}
    </section>
  );
}

function ShareDialog({ initial, onClose, onRun }: { initial: Partial<Shared>; onClose: () => void; onRun: (node: string, cmd: string) => void }) {
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [node, setNode] = useState(initial.node ?? nodes[0]?.name ?? "");
  const [path, setPath] = useState(initial.path ?? "/tank/media");
  const [mp, setMp] = useState("/media");
  const [owner, setOwner] = useState("100000");
  const [ro, setRo] = useState(false);
  const [pick, setPick] = useState<number[]>([]);
  const cts = (guests ?? []).filter((g) => g.type === "lxc" && g.node === node && !g.template);
  const valid = /^\/[A-Za-z0-9._/-]+$/.test(path) && /^\/[A-Za-z0-9._/-]+$/.test(mp) && path !== "/" && pick.length > 0;
  return (
    <Modal label="Pasta compartilhada" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Pasta compartilhada</h2>
      <div className="dialog-sub">roda no console do nó; você vê cada comando</div>
      <div className="form-grid">
        <label className="field">Nó<select value={node} onChange={(e) => { setNode(e.target.value); setPick([]); }} disabled={!!initial.node}>{nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select></label>
        <label className="field">Pasta no nó<input value={path} onChange={(e) => setPath(e.target.value)} disabled={!!initial.path} /></label>
        <label className="field">Aparece no contêiner em<input value={mp} onChange={(e) => setMp(e.target.value)} /></label>
        <label className="field">Dono da pasta
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>{OWNERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Contêiner sem privilégio enxerga o root como 100000 e o usuário 1000 como 101000 no host. Na dúvida, "todos podem escrever" funciona sempre.</p>
      <div className="field">Montar nos contêineres de {node}</div>
      <div className="guest-picks">
        {cts.map((g) => (
          <label key={g.id} className={`pick ${pick.includes(g.vmid) ? "on" : ""}`}>
            <input type="checkbox" checked={pick.includes(g.vmid)} onChange={() => setPick(pick.includes(g.vmid) ? pick.filter((x) => x !== g.vmid) : [...pick, g.vmid])} />
            <span className="mono">{g.vmid}</span> {g.name}
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} />Só leitura</label>
      <div className="dialog-actions">
        <button className="btn primary" disabled={!valid} onClick={() => onRun(node, sharedFolderScript(path, mp, pick, owner, ro))}>Criar no console</button>
        <button className="btn" onClick={onClose}>Cancelar</button>
      </div>
    </Modal>
  );
}

// ---------- Stacks do Nomade ----------

interface Stack { id: string; name: string; desc: string; apps: string[]; share?: { path: string; mp: string } }

export const STACKS: Stack[] = [
  { id: "midia", name: "Kit Mídia", desc: "Servidor de filmes e séries que baixa sozinho: Jellyfin, Sonarr, Radarr, Prowlarr, Bazarr e qBittorrent, todos vendo a mesma pasta.", apps: ["jellyfin", "sonarr", "radarr", "prowlarr", "bazarr", "qbittorrent"], share: { path: "/tank/media", mp: "/media" } },
  { id: "casa", name: "Kit Casa inteligente", desc: "Home Assistant com MQTT, Zigbee2MQTT, Node-RED e ESPHome.", apps: ["homeassistant", "mqtt", "zigbee2mqtt", "node-red", "esphome"] },
  { id: "rede", name: "Kit Rede", desc: "Bloqueio de anúncios, proxy reverso com HTTPS, monitor de serviços e VPN: AdGuard, Nginx Proxy Manager, Uptime Kuma e WireGuard.", apps: ["adguard", "nginxproxymanager", "uptimekuma", "wireguard"] },
  { id: "fotos", name: "Kit Fotos e documentos", desc: "Google Fotos e scanner de documentos em casa: Immich e Paperless-ngx, com pasta compartilhada.", apps: ["immich", "paperless-ngx"], share: { path: "/tank/docs", mp: "/data" } },
  { id: "dev", name: "Kit Dev", desc: "Git, banco, automações e senhas: Forgejo, PostgreSQL, n8n e Vaultwarden.", apps: ["forgejo", "postgresql", "n8n", "vaultwarden"] },
];

export function StacksTab({ catalog }: { catalog: App[] }) {
  const [open, setOpen] = useState<Stack | null>(null);
  const bySlug = useMemo(() => new Map(catalog.map((a) => [a.slug, a])), [catalog]);
  return (
    <>
      <p className="lede" style={{ marginTop: 12 }}>Kits prontos: vários apps do community-scripts instalados em sequência, já ligados na mesma pasta e, se quiser, publicados no Tailscale.</p>
      <div className="stack-grid">
        {STACKS.map((s) => (
          <button key={s.id} className="card stack" onClick={() => setOpen(s)}>
            <div className="stack-logos">
              {s.apps.map((slug) => bySlug.get(slug)?.logo ? <img key={slug} src={bySlug.get(slug)!.logo} alt="" width={28} height={28} /> : null)}
            </div>
            <b>{s.name}</b>
            <span>{s.desc}</span>
            <span className="mono muted">{s.apps.length} apps{s.share ? ` · pasta ${s.share.path}` : ""}</span>
          </button>
        ))}
      </div>
      {open && <StackDialog stack={open} bySlug={bySlug} onClose={() => setOpen(null)} />}
    </>
  );
}

function StackDialog({ stack, bySlug, onClose }: { stack: Stack; bySlug: Map<string, App>; onClose: () => void }) {
  const ui = useUI();
  const { data: status } = useStatus();
  const { data: settings } = useSettings();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [node, setNode] = useState(ui.node ?? nodes[0]?.name ?? "");
  const [apps, setApps] = useState(stack.apps.filter((a) => bySlug.has(a)));
  const [share, setShare] = useState(!!stack.share);
  const [path, setPath] = useState(stack.share?.path ?? "/tank/dados");
  const [mp, setMp] = useState(stack.share?.mp ?? "/data");
  const [ts, setTs] = useState(false);
  const [err, setErr] = useState("");
  const canTs = !!settings?.tailscale.configured;

  const run = async () => {
    setErr("");
    let expose = "";
    if (ts && canTs) {
      try {
        for (const slug of apps) {
          const port = bySlug.get(slug)?.port;
          if (!port) continue;
          const r = await api.tailscaleCommand({ action: "expose", byName: slug, hostname: slug, port });
          expose += r.command.trim() + "\n";
        }
      } catch (e) {
        return setErr((e as Error).message);
      }
    }
    const shareLine = share
      ? `\n  ID=$(pct list | awk -v h="$APP" '$NF==h{id=$1} END{print id}'); if [ -n "$ID" ]; then N=$(for i in $(seq 0 255); do pct config "$ID" | grep -q "^mp$i:" || { echo $i; break; }; done); pct set "$ID" -mp$N ${JSON.stringify(path)},mp=${JSON.stringify(mp)} && echo "==> $APP: ${path} em ${mp}"; fi`
      : "";
    // Um bloco só: o bash lê tudo antes de rodar, então o que o script de
    // cada app perguntar chega do teclado, não do resto do comando.
    const cmd = ` {
${share ? `mkdir -p ${JSON.stringify(path)} && chmod 0777 ${JSON.stringify(path)}\n` : ""}for APP in ${apps.join(" ")}; do
  echo; echo "==> Instalando $APP"
  if mode=default bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/$APP.sh)"; then :; else echo "!! $APP falhou, seguindo"; continue; fi${shareLine}
done
${expose}echo; echo "==> ${stack.name} pronto"
}`;
    onClose();
    ui.openConsole({ node, kind: "node", title: `Instalando ${stack.name}`, autorun: cmd });
  };

  return (
    <Modal label={stack.name} onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{stack.name}</h2>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>{stack.desc}</p>
      {!settings?.root && <div className="warn">Instalar roda como root no console: entre com root@pam.</div>}
      <label className="field">Nó<select value={node} onChange={(e) => setNode(e.target.value)}>{nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select></label>
      <div className="field">Apps</div>
      <div className="guest-picks">
        {stack.apps.map((slug) => {
          const a = bySlug.get(slug);
          return (
            <label key={slug} className={`pick ${apps.includes(slug) ? "on" : ""}`} title={a ? undefined : "não está no catálogo agora"}>
              <input type="checkbox" disabled={!a} checked={apps.includes(slug)} onChange={() => setApps(apps.includes(slug) ? apps.filter((x) => x !== slug) : [...apps, slug])} />
              {a?.name ?? slug}
            </label>
          );
        })}
      </div>
      <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />Pasta compartilhada entre os apps</label>
      {share && (
        <div className="form-grid">
          <label className="field">Pasta no nó<input value={path} onChange={(e) => setPath(e.target.value)} /></label>
          <label className="field">Dentro de cada app em<input value={mp} onChange={(e) => setMp(e.target.value)} /></label>
        </div>
      )}
      <label className="check" title={canTs ? "" : "Configure a auth key em Rede → VPN"}>
        <input type="checkbox" disabled={!canTs} checked={ts && canTs} onChange={(e) => setTs(e.target.checked)} />Publicar cada app no Tailscale{!canTs && <small> (configure a auth key em Rede)</small>}
      </label>
      <p className="muted" style={{ fontSize: 12 }}>
        Instala um app por vez no console do nó, com os padrões de cada script. Se algum perguntar algo, responda no console. A configuração
        dentro de cada app (ex.: dizer pro qBittorrent salvar em {mp}) continua sendo no próprio app.
      </p>
      {err && <div className="err">{err}</div>}
      <div className="dialog-actions">
        <button className="btn primary" disabled={!apps.length || !node || !settings?.root} onClick={run}>Instalar {apps.length} apps</button>
        <button className="btn" onClick={onClose}>Cancelar</button>
      </div>
    </Modal>
  );
}

// ---------- VM de imagem cloud ----------

const CLOUD_IMAGES: [string, string, string, string][] = [
  ["debian13", "Debian 13 (trixie)", "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2", "debian-13-genericcloud-amd64.qcow2"],
  ["ubuntu2404", "Ubuntu 24.04 LTS", "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", "ubuntu-24.04-cloudimg-amd64.qcow2"],
  ["debian12", "Debian 12 (bookworm)", "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2", "debian-12-genericcloud-amd64.qcow2"],
];

export function CloudVmDialog({ onClose }: { onClose: () => void }) {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [node, setNode] = useState(ui.node ?? nodes[0]?.name ?? "");
  const { data: opts } = useQuery({ queryKey: ["vm-options", node], queryFn: () => api.vmOptions(node), enabled: !!node });
  const { data: storages } = useQuery({ queryKey: ["storage-config"], queryFn: () => pve.get<Record<string, unknown>[]>("/storage") });
  const importStores = (storages ?? []).filter((s) => String(s.content ?? "").split(",").includes("import"));
  // Storage de diretório que existe neste nó (sem lista de nós = todos).
  const dirStore = (storages ?? []).find((s) => s.type === "dir" && (!s.nodes || String(s.nodes).split(",").includes(node)));
  const enableImport = useMutation({
    mutationFn: () => pve.put(`/storage/${enc(String(dirStore!.storage))}`, { content: `${dirStore!.content},import` }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["storage-config"] }),
  });
  const [step, setStep] = useState<"form" | "download" | "create" | "done">("form");
  const [upid, setUpid] = useState("");
  const [err, setErr] = useState("");
  const [vals, setVals] = useState<Values | null>(null);
  const [vmid, setVmid] = useState(0);

  const finish = async (v: Values) => {
    const img = CLOUD_IMAGES.find((x) => x[0] === v.image)!;
    const istore = String(v.importStorage);
    const id = Number(v.vmid) || opts!.nextid;
    const body = clean({
      vmid: id, name: v.name, ostype: "l26", cores: v.cores, memory: v.memory, cpu: "host", scsihw: "virtio-scsi-single",
      scsi0: `${v.storage}:0,import-from=${istore}:import/${img[3]},iothread=1,discard=on`, ide2: `${v.storage}:cloudinit`,
      boot: "order=scsi0", serial0: "socket", vga: "serial0", agent: "1", ciuser: v.user, cipassword: v.password,
      sshkeys: v.sshkeys ? encodeURIComponent(String(v.sshkeys).trim()) : "", ipconfig0: v.ip === "dhcp" || !v.ip ? "ip=dhcp" : `ip=${v.ip}${v.gw ? `,gw=${v.gw}` : ""}`,
      net0: `virtio,bridge=${v.bridge},firewall=1`, onboot: v.onboot ? 1 : 0, description: `Criada pela Mia a partir de ${img[1]}`,
    });
    setVmid(id);
    setStep("create");
    setUpid(await pve.post<string>(`/nodes/${enc(node)}/qemu`, body));
  };

  const afterCreate = async () => {
    try {
      if (vals && Number(vals.disk) > 3) await pve.put(`/nodes/${enc(node)}/qemu/${vmid}/resize`, { disk: "scsi0", size: `${vals.disk}G` });
      if (vals?.start) await api.guestAction({ type: "qemu", vmid }, "start");
      for (const k of ["guests", "overview", "status"]) qc.invalidateQueries({ queryKey: [k] });
      setStep("done");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal label="VM de imagem cloud" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Nova VM de imagem cloud</h2>
      <div className="dialog-sub">sem instalador: liga já pronta, com usuário, senha/chave e rede via Cloud-Init</div>
      {step === "form" && (
        <>
          {!importStores.length && (
            <div className="warn" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              A imagem precisa de um storage que aceite "Importação".
              {dirStore
                ? <button className="btn small primary" disabled={enableImport.isPending} onClick={() => enableImport.mutate()}>Ligar em {String(dirStore.storage)}</button>
                : <span>Ligue esse conteúdo num storage de diretório em Datacenter → Storages.</span>}
            </div>
          )}
          {enableImport.error && <div className="err">{(enableImport.error as Error).message}</div>}
          <div className="form-grid"><label className="field">Nó<select value={node} onChange={(e) => setNode(e.target.value)}>{nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select></label></div>
          {opts && (
            <SpecForm
              key={node + importStores.length}
              initial={{ image: "debian13", vmid: opts.nextid, cores: 2, memory: 2048, disk: 20, storage: opts.disks[0]?.storage ?? "", bridge: opts.bridges[0]?.iface ?? "vmbr0", importStorage: String(importStores[0]?.storage ?? ""), user: "mia", ip: "dhcp", start: true }}
              fields={[
                { key: "image", label: "Sistema", type: "select", options: CLOUD_IMAGES.map(([k, l]) => [k, l]) },
                { key: "name", label: "Nome", required: true, placeholder: "debian-cloud" },
                { key: "vmid", label: "ID", type: "number" },
                { key: "cores", label: "CPU", type: "number" },
                { key: "memory", label: "RAM (MB)", type: "number" },
                { key: "disk", label: "Disco (GB)", type: "number" },
                { key: "storage", label: "Storage do disco", type: "select", options: opts.disks.map((d) => [d.storage, `${d.storage} · ${bytes(d.avail)} livres`]) },
                { key: "importStorage", label: "Baixar a imagem em", type: "select", options: importStores.map((s) => [String(s.storage), String(s.storage)]) },
                { key: "bridge", label: "Bridge", type: "select", options: opts.bridges.map((b) => [b.iface, b.iface]) },
                { key: "ip", label: "IP", placeholder: "dhcp ou 10.0.10.60/24" },
                { key: "gw", label: "Gateway", show: (v) => v.ip !== "dhcp" && !!v.ip, placeholder: "10.0.10.1" },
                { key: "user", label: "Usuário", required: true },
                { key: "password", label: "Senha", type: "password" },
                { key: "sshkeys", label: "Chave SSH pública", type: "textarea", placeholder: "ssh-ed25519 AAAA…" },
                { key: "start", label: "Ligar depois de criar", type: "checkbox" },
                { key: "onboot", label: "Iniciar com o nó", type: "checkbox" },
              ]}
              submitLabel="Criar VM"
              onCancel={onClose}
              onSubmit={async (v) => {
                if (!v.importStorage) throw new Error("Escolha onde baixar a imagem");
                if (!v.password && !v.sshkeys) throw new Error("Defina uma senha ou uma chave SSH");
                setVals(v);
                const img = CLOUD_IMAGES.find((x) => x[0] === v.image)!;
                const have = await api.storageContent(node, String(v.importStorage)).catch(() => []);
                if (have.some((x) => x.volid.endsWith(`import/${img[3]}`))) return finish(v);
                setStep("download");
                setUpid((await api.downloadURL(node, String(v.importStorage), { url: img[2], filename: img[3], content: "import" })).upid);
              }}
            />
          )}
        </>
      )}
      {step === "download" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Baixando a imagem (só na primeira vez)…</p>
          <TaskLog key={upid} upid={upid} onDone={(ok) => (ok && vals ? finish(vals).catch((e) => setErr((e as Error).message)) : setErr("O download falhou."))} />
        </>
      )}
      {step === "create" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Criando a VM {vmid} e importando o disco…</p>
          <TaskLog key={upid} upid={upid} onDone={(ok) => (ok ? afterCreate() : setErr("A criação falhou."))} />
        </>
      )}
      {step === "done" && (
        <>
          <div className="all-good">VM {vmid} criada{vals?.start ? " e ligando" : ""}. Entra com {String(vals?.user)} pelo SSH ou pelo console.</div>
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => { onClose(); ui.openGuest(`qemu/${vmid}`); }}>Abrir a VM</button>
            <button className="btn" onClick={() => { onClose(); ui.openConsole({ node, kind: "qemu", vmid, title: String(vals?.name) }); }}>Console</button>
          </div>
        </>
      )}
      {err && <div className="err">{err}</div>}
    </Modal>
  );
}

// ---------- importar OVA ----------

export function OvaImportDialog({ node, volid, onClose }: { node: string; volid: string; onClose: () => void }) {
  const ui = useUI();
  const storage = volid.split(":")[0];
  const { data: meta, error } = useQuery({ queryKey: ["ova", volid], queryFn: () => pve.get<{ "create-args": Record<string, unknown>; disks: Record<string, string>; net?: Record<string, Record<string, string>>; warnings?: { key?: string; type: string }[] }>(`/nodes/${enc(node)}/storage/${enc(storage)}/import-metadata`, { volume: volid }) });
  const { data: opts } = useQuery({ queryKey: ["vm-options", node], queryFn: () => api.vmOptions(node) });
  const [upid, setUpid] = useState("");
  const [vmid, setVmid] = useState(0);
  return (
    <Modal label="Importar OVA" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Importar {volid.split("/").pop()}</h2>
      {error && <div className="err">{(error as Error).message}</div>}
      {upid ? (
        <>
          <TaskLog upid={upid} />
          <div className="dialog-actions"><button className="btn primary" onClick={() => { onClose(); ui.openGuest(`qemu/${vmid}`); }}>Abrir a VM</button></div>
        </>
      ) : meta && opts && (
        <SpecForm
          initial={{ name: String(meta["create-args"].name ?? "importada"), vmid: opts.nextid, cores: Number(meta["create-args"].cores ?? 2), memory: Number(meta["create-args"].memory ?? 2048), storage: opts.disks[0]?.storage ?? "", bridge: opts.bridges[0]?.iface ?? "vmbr0" }}
          fields={[
            { key: "name", label: "Nome", required: true }, { key: "vmid", label: "ID", type: "number" },
            { key: "cores", label: "CPU", type: "number" }, { key: "memory", label: "RAM (MB)", type: "number" },
            { key: "storage", label: "Storage dos discos", type: "select", options: opts.disks.map((d) => [d.storage, d.storage]) },
            { key: "bridge", label: "Bridge", type: "select", options: opts.bridges.map((b) => [b.iface, b.iface]) },
          ]}
          submitLabel="Importar"
          onCancel={onClose}
          onSubmit={async (v) => {
            const body: Record<string, unknown> = { ...meta["create-args"], name: v.name, vmid: v.vmid, cores: v.cores, memory: v.memory };
            for (const [k, src] of Object.entries(meta.disks)) body[k] = `${v.storage}:0,import-from=${src}`;
            for (const [k, n] of Object.entries(meta.net ?? {})) body[k] = `${n.model ?? "virtio"},bridge=${v.bridge}`;
            setVmid(Number(v.vmid));
            setUpid(await pve.post<string>(`/nodes/${enc(node)}/qemu`, clean(body)));
          }} />
      )}
    </Modal>
  );
}

// ---------- VM: Cloud-Init e monitor ----------

export function GuestAdvanced({ g }: { g: Guest }) {
  const qc = useQueryClient();
  const { data: cfg } = useQuery({ queryKey: ["guest-config", g.id], queryFn: () => api.guestConfig(g) });
  const [cmd, setCmd] = useState("info status");
  const [out, setOut] = useState("");
  const mon = useMutation({ mutationFn: () => pve.post<string>(`/nodes/${enc(g.node)}/qemu/${g.vmid}/monitor`, { command: cmd }), onSuccess: (r) => setOut(String(r)) });
  const hasCi = !!cfg && Object.keys(cfg.options).some((k) => k.startsWith("ci") || k === "ipconfig0" || k === "sshkeys");
  useEffect(() => setOut(""), [g.id]);
  return (
    <div>
      <div className="hw-title">Cloud-Init</div>
      {cfg && (hasCi || cfg.options.ciuser !== undefined ? null : <p className="muted" style={{ fontSize: 13 }}>Pra VMs criadas de imagem cloud. Preencher aqui só vale se a VM tiver drive de Cloud-Init.</p>)}
      {cfg && (
        <SpecForm key={JSON.stringify(cfg.options)} initial={{ ciuser: cfg.options.ciuser ?? "", cipassword: "", sshkeys: decodeURIComponent(cfg.options.sshkeys ?? ""), ipconfig0: cfg.options.ipconfig0 ?? "", ciupgrade: cfg.options.ciupgrade === "1" }}
          fields={[
            { key: "ciuser", label: "Usuário" }, { key: "cipassword", label: "Nova senha (vazio mantém)", type: "password" },
            { key: "ipconfig0", label: "Rede", placeholder: "ip=dhcp ou ip=10.0.10.60/24,gw=10.0.10.1", wide: true },
            { key: "sshkeys", label: "Chaves SSH", type: "textarea" },
            { key: "ciupgrade", label: "Atualizar pacotes no primeiro boot", type: "checkbox" },
          ]}
          submitLabel="Salvar e regenerar"
          onSubmit={async (v) => {
            const body: Record<string, string> = { ciuser: String(v.ciuser), ipconfig0: String(v.ipconfig0), sshkeys: v.sshkeys ? encodeURIComponent(String(v.sshkeys).trim()) : "", ciupgrade: v.ciupgrade ? "1" : "0" };
            if (v.cipassword) body.cipassword = String(v.cipassword);
            await api.guestOptions(g, body);
            await pve.put(`/nodes/${enc(g.node)}/qemu/${g.vmid}/cloudinit`).catch(() => {});
            qc.invalidateQueries({ queryKey: ["guest-config", g.id] });
          }} />
      )}
      <div className="hw-title">Monitor do QEMU</div>
      {g.status !== "running" ? <p className="muted" style={{ fontSize: 13 }}>Só com a VM ligada.</p> : (
        <>
          <form className="hw-res" onSubmit={(e) => { e.preventDefault(); mon.mutate(); }}>
            <label className="field">Comando<input className="mono" value={cmd} onChange={(e) => setCmd(e.target.value)} list="qmp-cmds" /></label>
            <datalist id="qmp-cmds">{["info status", "info cpus", "info block", "info version", "help"].map((c) => <option key={c} value={c} />)}</datalist>
            <button className="btn small primary" disabled={mon.isPending}>Rodar</button>
          </form>
          {mon.error && <div className="err">{(mon.error as Error).message}</div>}
          {out && <pre className="logbox" style={{ maxHeight: 220 }}>{out}</pre>}
        </>
      )}
    </div>
  );
}


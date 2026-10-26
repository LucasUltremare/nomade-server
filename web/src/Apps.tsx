import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type App } from "./api";
import { Modal } from "./Dialogs";
import { StacksTab } from "./Extras";
import { IconExternal, IconX } from "./icons";
import { useGuests, useSettings, useStatus, useUI } from "./state";

const TYPES: { v: string; label: string }[] = [
  { v: "", label: "Todos" },
  { v: "lxc", label: "Contêineres" },
  { v: "vm", label: "VMs" },
  { v: "pve", label: "Ferramentas do host" },
  { v: "addon", label: "Add-ons" },
];

const PAGE = 90;

export function AppsPage() {
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.apps(),
    staleTime: 30 * 60_000,
  });
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [type, setType] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<App | null>(null);
  const [view, setView] = useState<"apps" | "stacks">("apps");

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const hits = (data?.apps ?? []).filter(
      (a) =>
        (!cat || a.categories.includes(cat)) &&
        (!type || a.type === type) &&
        (!term || `${a.name} ${a.slug} ${a.description}`.toLowerCase().includes(term)),
    );
    if (!term) return hits;
    // Quem tem o termo no nome vem antes de quem só cita na descrição.
    const rank = (a: App) => {
      const n = a.name.toLowerCase();
      return a.slug === term || n === term ? 0 : n.startsWith(term) || a.slug.startsWith(term) ? 1 : n.includes(term) ? 2 : 3;
    };
    return hits.map((a) => [rank(a), a] as const).sort((x, y) => x[0] - y[0]).map(([, a]) => a);
  }, [data, q, cat, type]);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Apps</h1>
          <span className="tag">
            {data ? `${list.length} de ${data.apps.length} · community-scripts` : "community-scripts"}
          </span>
        </div>
        <button className="btn small" onClick={() => api.apps(true).then(() => refetch())} disabled={isFetching}>
          {isFetching ? "Atualizando…" : "Atualizar catálogo"}
        </button>
      </div>
      <div className="seg page-tabs" role="tablist">
        <button role="tab" aria-pressed={view === "apps"} onClick={() => setView("apps")}>Catálogo</button>
        <button role="tab" aria-pressed={view === "stacks"} onClick={() => setView("stacks")}>Stacks</button>
      </div>
      {view === "stacks" ? <StacksTab catalog={data?.apps ?? []} /> : <>
      <p className="lede" style={{ marginTop: 12 }}>
        Os scripts do <a href="https://community-scripts.org" target="_blank" rel="noreferrer">Proxmox VE Helper-Scripts</a>,
        rodando no console do nó. Você acompanha a instalação ao vivo e pode responder o que o script perguntar.
      </p>

      <div className="filters">
        <input placeholder="Buscar app…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} aria-label="Buscar app" />
        <div className="seg" role="group" aria-label="Tipo">
          {TYPES.map((t) => (
            <button key={t.v} aria-pressed={type === t.v} onClick={() => { setType(t.v); setLimit(PAGE); }}>{t.label}</button>
          ))}
        </div>
      </div>
      {data && (
        <div className="cat-chips">
          <button aria-pressed={cat === ""} onClick={() => setCat("")}>Todas</button>
          {data.categories.map((c) => (
            <button key={c.name} aria-pressed={cat === c.name} onClick={() => { setCat(cat === c.name ? "" : c.name); setLimit(PAGE); }}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {isLoading && <p className="muted">Baixando o catálogo…</p>}
      {error && <div className="err">{(error as Error).message}</div>}

      <div className="app-grid">
        {list.slice(0, limit).map((a) => (
          <button key={a.slug} className="app-card" onClick={() => setOpen(a)}>
            <AppLogo app={a} />
            <div className="app-card-text">
              <b>{a.name}</b>
              <span>{a.description}</span>
            </div>
            <span className="app-type mono">{typeLabel(a)}</span>
          </button>
        ))}
      </div>
      {list.length > limit && (
        <div style={{ textAlign: "center", marginTop: 18 }}>
          <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Mostrar mais ({list.length - limit})</button>
        </div>
      )}
      {data && !list.length && <p className="muted">Nenhum app encontrado.</p>}
      </>}
      {open && <AppDialog app={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function typeLabel(a: App) {
  return { lxc: "LXC", vm: "VM", pve: "host", addon: "add-on", turnkey: "turnkey" }[a.type] ?? a.type;
}

function AppLogo({ app, size = 40 }: { app: App; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!app.logo || broken) {
    return <span className="app-logo fallback" style={{ width: size, height: size }}>{app.name[0]}</span>;
  }
  return <img className="app-logo" src={app.logo} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
}

/** Onde o script roda: no host (shell do nó), dentro de um LXC, ou só copiando. */
function runsOn(a: App): "pve" | "lxc" | "manual" {
  if (a.type !== "addon" || a.executeIn.includes("pve") || a.executeIn.length === 0) return "pve";
  if (a.executeIn.includes("lxc")) return "lxc";
  return "manual";
}

function installCommand(a: App, cpu: number, ram: number, disk: number) {
  const curl = `bash -c "$(curl -fsSL ${a.scriptUrl})"`;
  if (a.type === "lxc") return ` mode=default var_cpu="${cpu}" var_ram="${ram}" var_disk="${disk}" ${curl}`;
  return ` ${curl}`;
}

function AppDialog({ app, onClose }: { app: App; onClose: () => void }) {
  const ui = useUI();
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const { data: settings } = useSettings();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [node, setNode] = useState(ui.node ?? nodes[0]?.name ?? "");
  const [cpu, setCpu] = useState(app.cpu || 1);
  const [ram, setRam] = useState(app.ram || 1024);
  const [disk, setDisk] = useState(app.disk || 4);
  const [ts, setTs] = useState(false);
  const [target, setTarget] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const where = runsOn(app);
  const lxcs = (guests ?? []).filter((g) => g.type === "lxc" && g.status === "running");
  const cmd = installCommand(app, cpu, ram, disk).trim();
  const canTs = app.type === "lxc" && app.port > 0 && !!settings?.tailscale.configured;

  const install = async () => {
    setErr("");
    if (where === "lxc") {
      const g = lxcs.find((x) => x.id === target);
      if (!g) return setErr("Escolha o contêiner.");
      ui.openConsole({ node: g.node, kind: "lxc", vmid: g.vmid, title: `${app.name} em ${g.name}`, autorun: ` ${cmd}` });
      onClose();
      return;
    }
    let full = installCommand(app, cpu, ram, disk);
    if (ts && canTs) {
      setBusy(true);
      try {
        const r = await api.tailscaleCommand({ action: "expose", byName: app.slug, hostname: app.slug, port: app.port });
        full = ` if${full}; then\n${r.command.trimStart()}fi`;
      } catch (e) {
        setBusy(false);
        return setErr((e as Error).message);
      }
      setBusy(false);
    }
    ui.openConsole({ node, kind: "node", title: `Instalando ${app.name}`, autorun: full });
    onClose();
  };

  return (
    <Modal label={app.name} onClose={onClose} className="app-dialog">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <div className="app-dialog-head">
        <AppLogo app={app} size={52} />
        <div>
          <h2>{app.name}</h2>
          <div className="dialog-sub">
            {typeLabel(app)}{app.port ? ` · porta ${app.port}` : ""}{app.os ? ` · ${app.os} ${app.osVersion}` : ""}
          </div>
        </div>
      </div>
      <p style={{ color: "var(--ink-2)", fontSize: 13 }}>{app.description}</p>
      <div className="chips" style={{ marginBottom: 6 }}>
        {app.categories.map((c) => <span key={c}>{c}</span>)}
        {app.privileged && <span>privilegiado</span>}
      </div>
      {app.notes.length > 0 && (
        <ul className="notes">
          {app.notes.map((n, i) => <li key={i} className={n.type}>{n.text}</li>)}
        </ul>
      )}
      {(app.defaultUser || app.defaultPass) && (
        <dl className="kv">
          <dt>Login padrão</dt><dd>{app.defaultUser || "—"} / {app.defaultPass || "—"}</dd>
        </dl>
      )}

      {settings && !settings.root && (
        <div className="warn">Instalar roda no shell do nó como root: entre com <b>root@pam</b>.</div>
      )}

      {where === "pve" && (
        <div className="form-grid">
          <label className="field">
            Nó
            <select value={node} onChange={(e) => setNode(e.target.value)}>
              {nodes.map((n) => <option key={n.name}>{n.name}</option>)}
            </select>
          </label>
          {app.type === "lxc" && (
            <>
              <label className="field">CPU<input type="number" min={1} max={64} value={cpu} onChange={(e) => setCpu(+e.target.value)} /></label>
              <label className="field">RAM (MB)<input type="number" min={128} value={ram} onChange={(e) => setRam(+e.target.value)} /></label>
              <label className="field">Disco (GB)<input type="number" min={1} value={disk} onChange={(e) => setDisk(+e.target.value)} /></label>
            </>
          )}
        </div>
      )}
      {where === "lxc" && (
        <label className="field">
          Rodar dentro de qual contêiner?
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Escolha…</option>
            {lxcs.map((g) => <option key={g.id} value={g.id}>{g.vmid} · {g.name} ({g.node})</option>)}
          </select>
        </label>
      )}
      {app.type === "lxc" && app.port > 0 && (
        <label className="check" title={settings?.tailscale.configured ? "" : "Configure a auth key em Rede → Tailscale"}>
          <input type="checkbox" checked={ts && canTs} disabled={!canTs} onChange={(e) => setTs(e.target.checked)} />
          Publicar no Tailscale em <span className="mono">https://{app.slug}.&lt;sua-tailnet&gt;.ts.net</span>
          {!settings?.tailscale.configured && <small> (configure a auth key em Rede)</small>}
        </label>
      )}

      <div className="cmd-preview mono">{cmd}</div>
      {err && <div className="err">{err}</div>}
      <div className="dialog-actions">
        {where !== "manual" ? (
          <button className="btn primary" onClick={install} disabled={busy || (where === "pve" && !node)}>
            {busy ? "Preparando…" : "Instalar no console"}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>Esse script roda dentro de uma VM: copie o comando acima.</span>
        )}
        <button className="btn" onClick={() => navigator.clipboard?.writeText(cmd)}>Copiar comando</button>
        {app.website && <a className="btn" href={app.website} target="_blank" rel="noreferrer"><IconExternal width={14} height={14} /> Site</a>}
        <a className="btn" href={`https://github.com/community-scripts/ProxmoxVE/blob/main/${app.script}`} target="_blank" rel="noreferrer">
          Ver script
        </a>
      </div>
    </Modal>
  );
}

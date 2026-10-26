import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MyApp } from "./api";
import { Modal } from "./Dialogs";
import { kindLabel } from "./format";
import { IconExternal, IconX } from "./icons";
import { navigate } from "./router";
import { useSettings, useStatus, useUI } from "./state";

/** Atualiza os pacotes de todos os LXCs rodando no nó (apt, apk ou dnf). */
export const UPDATE_ALL_LXC = ` for id in $(pct list | awk 'NR>1 && $2=="running"{print $1}'); do
  echo; echo "==> CT $id ($(pct config $id | awk '/^hostname:/{print $2}'))"
  pct exec "$id" -- sh -c 'if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade; elif command -v apk >/dev/null; then apk -U upgrade; elif command -v dnf >/dev/null; then dnf -y upgrade; else echo "gerenciador de pacotes desconhecido"; fi'
done; echo; echo "==> Pronto"`;

export function MyAppsPage() {
  const ui = useUI();
  const [all, setAll] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ["myapps", all], queryFn: () => api.myApps(all), refetchInterval: 30_000 });
  const { data: status } = useStatus();
  const { data: settings } = useSettings();
  const [editing, setEditing] = useState<MyApp | null>(null);
  const [updMenu, setUpdMenu] = useState(false);
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const withUrl = (data ?? []).filter((a) => a.url);
  const rest = (data ?? []).filter((a) => !a.url);
  const up = withUrl.filter((a) => a.up).length;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Meus apps</h1>
          <span className="tag">{data ? `${up} de ${withUrl.length} no ar` : "…"}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div className="notif">
            <button className="btn small" onClick={() => setUpdMenu(!updMenu)} disabled={!settings?.root} title={settings?.root ? undefined : "Só root@pam"}>
              Atualizar tudo
            </button>
            {updMenu && (
              <div className="notif-pop" style={{ width: 280 }}>
                <p className="muted" style={{ fontSize: 12, margin: "4px 6px 8px" }}>
                  Atualiza os pacotes (apt/apk/dnf) de todos os contêineres ligados, um nó por vez, no console.
                </p>
                {nodes.map((n) => (
                  <button key={n.name} className="notif-item" style={{ borderLeftColor: "var(--blue)" }} onClick={() => {
                    setUpdMenu(false);
                    ui.openConsole({ node: n.name, kind: "node", title: `Atualizando LXCs de ${n.name}`, autorun: UPDATE_ALL_LXC });
                  }}>
                    <b>LXCs do {n.name}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Mostrar escondidos</label>
        </div>
      </div>
      {isLoading && <p className="muted">Procurando seus apps…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {settings?.tailscale.configured && !settings.tailscale.tailnet && (
        <div className="warn" style={{ marginTop: 16 }}>
          Pra aparecer o link do Tailscale, coloque o domínio da sua tailnet em <a href="/rede" onClick={(e) => { e.preventDefault(); navigate("/rede"); }}>Rede → VPN</a>.
        </div>
      )}

      <div className="myapps">
        {withUrl.map((a) => <AppTile key={a.id} a={a} onEdit={() => setEditing(a)} />)}
      </div>
      {data && !withUrl.length && (
        <div className="all-good" style={{ background: "var(--bg-sunken)" }}>
          Nenhum app com endereço ainda. Instale um pela <a href="/apps" onClick={(e) => { e.preventDefault(); navigate("/apps"); }}>loja</a> ou
          configure a porta de um guest abaixo.
        </div>
      )}

      {rest.length > 0 && (
        <section className="section">
          <div className="section-head"><div><h2>Sem endereço</h2><p>Guests sem porta conhecida ou sem IP descoberto. Configure a porta pra virar card.</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Guest</th><th>Nó</th><th>IP</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rest.map((a) => (
                  <tr key={a.id} style={{ cursor: "default", opacity: a.hidden ? 0.5 : 1 }}>
                    <td><span className="mono muted">{kindLabel(a)} {a.vmid}</span> {a.title}</td>
                    <td className="mono">{a.node}</td>
                    <td className="mono">{a.ip || (a.type === "qemu" && a.status === "running" ? "precisa do agente QEMU" : "—")}</td>
                    <td><span className="status"><span className={`dot ${a.status === "running" ? "running" : "stopped"}`} />{a.status}</span></td>
                    <td style={{ textAlign: "right" }}><button className="btn small" onClick={() => setEditing(a)}>Configurar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {editing && <EditApp a={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AppTile({ a, onEdit }: { a: MyApp; onEdit: () => void }) {
  const ui = useUI();
  const [broken, setBroken] = useState(false);
  const state = a.status !== "running" ? "off" : a.up === null ? "unknown" : a.up ? "up" : "down";
  const label = { up: a.latency ? `no ar · ${a.latency} ms` : "no ar", down: "não responde", off: "desligado", unknown: "sem teste" }[state];
  return (
    <div className={`app-tile ${state} ${a.hidden ? "hidden" : ""}`}>
      <a className="app-tile-main" href={a.url} target="_blank" rel="noreferrer">
        {a.logo && !broken
          ? <img src={a.logo} alt="" width={44} height={44} onError={() => setBroken(true)} />
          : <span className="app-logo fallback" style={{ width: 44, height: 44 }}>{a.title[0]}</span>}
        <div>
          <b>{a.title}</b>
          <span className="mono muted">{a.ip}:{a.port}</span>
        </div>
      </a>
      <div className="app-tile-foot">
        <span className="status"><span className={`dot ${state === "up" ? "running" : state === "down" ? "hot" : "stopped"}`} />{label}</span>
        <span className="app-tile-actions">
          {a.tsUrl && <a className="btn small" href={a.tsUrl} target="_blank" rel="noreferrer" title="Abrir pelo Tailscale">Tailscale <IconExternal width={12} height={12} /></a>}
          {a.slug && a.type === "lxc" && a.status === "running" && (
            <button className="btn small" title="Roda o update do community-scripts dentro do contêiner"
              onClick={() => ui.openConsole({ node: a.node, kind: "lxc", vmid: a.vmid, title: `Atualizando ${a.title}`, autorun: "update" })}>
              Atualizar app
            </button>
          )}
          <button className="btn small" onClick={() => ui.openGuest(a.id)}>Guest</button>
          <button className="btn small" onClick={onEdit}>Editar</button>
        </span>
      </div>
    </div>
  );
}

function EditApp({ a, onClose }: { a: MyApp; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(a.title);
  const [port, setPort] = useState(a.port || 0);
  const [scheme, setScheme] = useState(a.scheme || "http");
  const [path, setPath] = useState(a.path);
  const [hidden, setHidden] = useState(a.hidden);
  const save = useMutation({
    mutationFn: () => api.saveMyApp(a.vmid, { title: title === a.name ? "" : title, port, scheme, path, hidden }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["myapps"] }); onClose(); },
  });
  return (
    <Modal label={`Editar ${a.title}`} onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{a.title}</h2>
      <div className="dialog-sub">{kindLabel(a)} {a.vmid} · {a.node} · {a.ip || "sem IP"}</div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <label className="field span2">Nome no card<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field">Protocolo
            <select value={scheme} onChange={(e) => setScheme(e.target.value)}><option value="http">http</option><option value="https">https</option></select>
          </label>
          <label className="field">Porta<input type="number" min={0} max={65535} value={port || ""} onChange={(e) => setPort(+e.target.value)} placeholder={a.slug ? "do catálogo" : "ex.: 8080"} /></label>
          <label className="field span2">Caminho<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/ (ex.: /admin)" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />Esconder do Meus apps</label>
        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>Salvar</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

import { useMemo, useState } from "react";
import type { Guest, GuestType, Range } from "./api";
import { DotPlot, binSamples } from "./charts/DotPlot";
import { Trend } from "./charts/Trend";
import { HOT, IDLE, bytesPair, health, kindLabel, num, pct, pctFixed, uptime } from "./format";
import { CloudVmDialog } from "./Extras";
import { navigate } from "./router";
import { useFavorites, useGuests, useOverview, useStatus, useUI } from "./state";

const RANGE_LABEL: Record<Range, [string, string]> = {
  "24h": ["últimas 24h", "ontem"],
  "7d": ["últimos 7 dias", "semana anterior"],
  "30d": ["últimos 30 dias", "mês anterior"],
};

export function OverviewPage() {
  const ui = useUI();
  const { data: ov, error, isLoading } = useOverview();
  const favs = useFavorites(ov?.guests);
  const bins = useMemo(() => binSamples(ov?.samples ?? []), [ov]);

  if (isLoading) return <div className="content muted">Carregando o cluster…</div>;
  if (error && !ov) return <div className="content"><div className="err">{(error as Error).message}</div></div>;
  if (!ov) return null;

  const [label, prev] = RANGE_LABEL[ov.range];
  const d = ov.load.delta;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Carga do cluster</h1>
          <span className="tag">{label} · {ov.load.guestsActive} guests ativos</span>
        </div>
        <div className="seg" role="group" aria-label="Período">
          {(["24h", "7d", "30d"] as Range[]).map((r) => (
            <button key={r} aria-pressed={ui.range === r} onClick={() => ui.setRange(r)}>{r}</button>
          ))}
        </div>
      </div>

      <div className="hero">
        <span className="hero-num" title={`Média de CPU do cluster, ${label}. Agora: ${pct(ov.load.now)}`}>
          {pctFixed(ov.load.avg)}
        </span>
        {d !== null && (
          <span className="hero-delta">{d >= 0 ? "↑" : "↓"} {num(Math.abs(d))}% vs {prev}</span>
        )}
      </div>
      <p className="lede">
        {bins.perDot === 1 ? "Cada ponto é uma amostra" : `Cada ponto são ~${bins.perDot} amostras`} de CPU de um guest.
        Quanto mais à direita, mais perto do limite que ele tem alocado.
        {bins.clipped && " Colunas com anel no topo passam da escala."}
      </p>

      <div className="legend" style={{ marginBottom: 12 }}>
        <span><i className="sw" style={{ background: "var(--c-idle)" }} />Ocioso &lt;{IDLE}%</span>
        <span><i className="sw" style={{ background: "var(--c-normal)" }} />Normal</span>
        <span><i className="sw" style={{ background: "var(--c-crit)" }} />Crítico ≥{HOT}%</span>
      </div>
      {bins.total ? (
        <DotPlot bins={bins} guests={ov.guests} onOpenGuest={ui.openGuest} />
      ) : (
        <p className="muted">Sem amostras de guests nesse período.</p>
      )}

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Tendência de recursos</h2>
            <p>CPU e memória do cluster somados, {label}</p>
          </div>
          <div className="legend">
            <span><i className="sw sw-line" style={{ background: "var(--c-cpu)" }} />CPU</span>
            <span><i className="sw sw-line" style={{ background: "var(--c-ram)" }} />RAM</span>
            <span><i className="sw sw-hatch" />Janela de backup</span>
          </div>
        </div>
        <Trend ov={ov} />
      </section>

      {ov.warnings.length > 0 && <div className="warn">{ov.warnings.join(" · ")}</div>}

      <div className="cards">
        <button className="card primary" onClick={() => ui.setBackupOpen(true)}>
          <div className="card-top">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="0" y="0" width="7" height="7" fill="#fff" /><rect x="8" y="8" width="7" height="7" fill="#fff" opacity="0.6" />
            </svg>
            <kbd style={{ border: 0 }}>⌘ B</kbd>
          </div>
          <div className="card-name">Novo backup<br />do cluster</div>
        </button>
        {favs.list.map((g) => <GuestCard key={g.id} g={g} />)}
        {!favs.list.length && <div className="card card-empty">Abra um guest e marque ☆ pra ele aparecer aqui.</div>}
      </div>
    </div>
  );
}

function GuestCard({ g }: { g: Guest }) {
  const ui = useUI();
  const h = health(g);
  return (
    <button className="card" onClick={() => ui.openGuest(g.id)}>
      <div className="card-top">
        <span>{kindLabel(g)} {g.vmid} · {g.node}</span>
        <span className={`dot ${h}`} title={h} />
      </div>
      <div className="card-name">{g.name}</div>
      <div className={`bar ${h === "hot" ? "hot" : ""}`}><i style={{ width: `${g.status === "running" ? g.cpu : 0}%` }} /></div>
      <div className="card-foot">
        <span>{g.status === "running" ? `CPU ${pct(Math.round(g.cpu))}` : g.status}</span>
        <span>{bytesPair(g.status === "running" ? g.mem : 0, g.maxmem)}</span>
      </div>
    </button>
  );
}

export function GuestsPage({ type }: { type: GuestType }) {
  const ui = useUI();
  const { data, error, isLoading } = useGuests();
  const [q, setQ] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [cloud, setCloud] = useState(false);
  const rows = (data ?? [])
    .filter((g) => g.type === type)
    .filter((g) => !onlyRunning || g.status === "running")
    .filter((g) => !q || `${g.vmid} ${g.name} ${g.node} ${g.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  const title = type === "qemu" ? "Máquinas virtuais" : "Contêineres LXC";
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <span className="tag">{rows.length} de {(data ?? []).filter((g) => g.type === type).length}</span>
        </div>
        {type === "lxc" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn small" onClick={() => navigate("/apps")}>Instalar app</button>
            <button className="btn small primary" onClick={() => ui.setNewLxc(ui.node ?? "")}>Novo LXC</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn small" onClick={() => setCloud(true)}>De imagem cloud</button>
            <button className="btn small primary" onClick={() => ui.setNewVm(ui.node ?? "")}>Nova VM</button>
          </div>
        )}
        {cloud && <CloudVmDialog onClose={() => setCloud(false)} />}
      </div>
      <div className="filters">
        <input placeholder="Filtrar por nome, id, nó, tag…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filtrar" />
        <label className="muted" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} /> só rodando
        </label>
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Nome</th><th>Status</th><th>Nó</th>
                <th className="num">CPU</th><th className="num">Memória</th><th className="num">Uptime</th><th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const h = health(g);
                return (
                  <tr key={g.id} onClick={() => ui.openGuest(g.id)} tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && ui.openGuest(g.id)}>
                    <td className="mono">{g.vmid}</td>
                    <td>{g.name}{g.template && <span className="muted"> · template</span>}</td>
                    <td><span className="status"><span className={`dot ${h}`} />{g.status}</span></td>
                    <td className="mono">{g.node}</td>
                    <td className="num">
                      {g.status === "running" ? (
                        <><span className={`cell-bar ${h === "hot" ? "hot" : ""}`}><i style={{ width: `${g.cpu}%` }} /></span>{pct(g.cpu)}</>
                      ) : "—"}
                    </td>
                    <td className="num">{g.status === "running" ? bytesPair(g.mem, g.maxmem) : "—"}</td>
                    <td className="num">{uptime(g.uptime)}</td>
                    <td><span className="chips">{g.tags.map((t) => <span key={t}>{t}</span>)}</span></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="muted">Nenhum guest.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function NodesPage() {
  const ui = useUI();
  const { data } = useStatus();
  const { data: guests } = useGuests();
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Nós</h1>
          <span className="tag">{data ? `${data.cluster.nodesOnline}/${data.cluster.nodes} online` : "…"}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small" onClick={() => ui.setNewVm(ui.node ?? "")}>Nova VM</button>
          <button className="btn small primary" onClick={() => ui.setNewLxc(ui.node ?? "")}>Novo LXC</button>
        </div>
      </div>
      <div className="node-grid">
        {(data?.nodes ?? []).map((n) => {
          const count = (guests ?? []).filter((g) => g.node === n.name && !g.template);
          return (
            <button key={n.name} className="card node-card" onClick={() => { ui.setNode(n.name); navigate(`/nos/${encodeURIComponent(n.name)}`); }} aria-pressed={ui.node === n.name}>
              <div className="card-top">
                <span>{n.ip ?? ""}</span>
                <span className={`dot ${n.online ? (n.cpu >= HOT ? "hot" : "running") : "stopped"}`} />
              </div>
              <div className="card-name">{n.name}</div>
              <div className="bar"><i style={{ width: `${n.cpu}%` }} /></div>
              <div className="card-foot"><span>CPU {pct(Math.round(n.cpu))} · {n.maxcpu} threads</span><span>{bytesPair(n.mem, n.maxmem)}</span></div>
              <div className="card-foot" style={{ marginTop: 6 }}>
                <span>{count.filter((g) => g.status === "running").length}/{count.length} guests rodando</span>
                <span>{n.online ? uptime(n.uptime) : "offline"}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SoonPage({ title, what }: { title: string; what: string }) {
  return (
    <div className="content">
      <div className="soon">
        <h1>{title}</h1>
        <p>{what}</p>
        <p className="muted">Ainda não está no Mia. Enquanto isso, dá pra fazer pelo painel do Proxmox na porta 8006.</p>
      </div>
    </div>
  );
}

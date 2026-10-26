import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { bytes, bytesPair, num, pct, uptime } from "./format";
import { IconTerminal } from "./icons";
import { useStatus, useUI } from "./state";

/** URL do pveproxy no mesmo host (o Mia roda no nó, a API do PVE na 8006). */
export const pveURL = (hash = "") => `https://${location.hostname}:8006/${hash}`;

export function shellURL(node: string) {
  const q = new URLSearchParams({ console: "shell", xtermjs: "1", vmid: "0", vmname: "", node, cmd: "" });
  return pveURL(`?${q}`);
}

export function NodePanel() {
  const ui = useUI();
  const { data: status } = useStatus();
  const nodes = status?.nodes ?? [];
  const name = ui.node ?? nodes.find((n) => n.online)?.name ?? nodes[0]?.name;
  const { data: nd, error } = useQuery({
    queryKey: ["node", name],
    queryFn: () => api.node(name!),
    enabled: !!name,
    refetchInterval: 10_000,
    placeholderData: (prev) => (prev?.name === name ? prev : undefined),
  });

  const load = nd?.load?.[0] ? num(parseFloat(nd.load[0])) : null;

  return (
    <aside className="panel" aria-label="Nó selecionado">
      <h2>Nó {name ?? "…"}</h2>
      {nodes.length > 1 && (
        <div className="pills" role="group" aria-label="Escolher nó">
          {nodes.map((n) => (
            <button key={n.name} aria-pressed={n.name === name} onClick={() => ui.setNode(n.name)}
              className={n.online ? "" : "off"} title={n.online ? undefined : "offline"}>
              {n.name}
            </button>
          ))}
        </div>
      )}
      {nodes.length <= 1 && <div style={{ height: 22 }} />}

      {error && <div className="panel-skel">Não consegui carregar o nó: {(error as Error).message}</div>}
      {nd && !nd.online && <div className="panel-skel">Nó offline.</div>}

      {nd?.online && (
        <>
          <div className="panel-label">Uso de CPU</div>
          <div className="panel-cpu">
            <span className="big">{pct(Math.round(nd.cpu))}</span>
            <span className="mono">{nd.threads} threads{load ? ` · load ${load}` : ""}</span>
          </div>

          <ServerArt />

          <dl className="stats">
            <div><dt>Memória</dt><dd>{bytesPair(nd.memUsed, nd.memTotal)}</dd></div>
            <div><dt>Uptime</dt><dd>{uptime(nd.uptime)}</dd></div>
            <div><dt>Processador</dt><dd title={nd.model}>{nd.model || "—"}</dd></div>
            <div><dt>IP</dt><dd>{nd.ip || "—"}</dd></div>
          </dl>

          {nd.pool && (
            <div className="pool">
              <div className="pool-head">
                <span>{nd.pool.kind === "zfs" ? "Pool ZFS" : "Storage"} · {nd.pool.name}</span>
                <span className="mono">{bytesPair(nd.pool.used, nd.pool.total)}</span>
              </div>
              <div className="bar" title={`${bytes(nd.pool.total - nd.pool.used)} livres`}>
                <i style={{ width: `${(nd.pool.used / nd.pool.total) * 100}%` }} />
              </div>
            </div>
          )}
        </>
      )}

      {nd && (
        <>
          <div className="panel-sub">GUESTS NESTE NÓ</div>
          <ul className="glist">
            {nd.guests.filter((g) => !g.template).map((g) => (
              <li key={g.id}>
                <button onClick={() => ui.openGuest(g.id)}>
                  <span className="mono">{g.vmid}</span>
                  <span className="name">{g.name}</span>
                  <span className="mono">{g.status}</span>
                </button>
              </li>
            ))}
            {!nd.guests.length && <li className="panel-skel" style={{ padding: "10px 0" }}>Nenhum guest.</li>}
          </ul>
        </>
      )}

      {name && (
        <div className="panel-actions">
          <a className="btn-white" href={shellURL(name)} target="_blank" rel="noreferrer">
            <IconTerminal width={16} height={16} /> Abrir shell
          </a>
          <button className="btn-ghost" disabled title="Em breve">Migrar guests</button>
        </div>
      )}
    </aside>
  );
}

function ServerArt() {
  return (
    <svg className="panel-art" viewBox="0 0 230 92" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M140 2h56v14" />
      <circle cx="140" cy="2" r="1.5" fill="currentColor" />
      <rect x="10" y="22" width="210" height="58" rx="5" />
      <rect x="22" y="32" width="56" height="38" rx="2" />
      {[38, 44, 50, 56, 62].map((y) => <path key={y} d={`M26 ${y}h48`} />)}
      <rect x="88" y="36" width="30" height="30" rx="2" />
      <rect x="95" y="43" width="16" height="16" fill="currentColor" fillOpacity="0.35" />
      {[126, 132, 138, 144].map((x) => <path key={x} d={`M${x} 36v30`} strokeWidth="2" />)}
      <rect x="160" y="34" width="48" height="14" rx="2" />
      <rect x="160" y="54" width="48" height="14" rx="2" />
      <circle cx="120" cy="51" r="38" strokeDasharray="1 3" opacity="0.6" />
    </svg>
  );
}

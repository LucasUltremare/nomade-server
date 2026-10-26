import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type HealthCheck } from "./api";
import { bytes } from "./format";
import { TaskLog } from "./Tasks";
import { useSettings, useUI } from "./state";

export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 120_000 });

const LEVEL: Record<HealthCheck["level"], string> = { crit: "Crítico", warn: "Atenção", ok: "OK" };

export function HealthPage() {
  const ui = useUI();
  const qc = useQueryClient();
  const { data, error, isLoading, isFetching, refetch } = useHealth();
  const { data: settings } = useSettings();
  const [aptTask, setAptTask] = useState<{ node: string; upid: string } | null>(null);

  if (isLoading) return <div className="content muted">Checando o cluster…</div>;
  if (error) return <div className="content"><div className="err">{(error as Error).message}</div></div>;
  if (!data) return null;
  const crit = data.checks.filter((c) => c.level === "crit").length;
  const warn = data.checks.filter((c) => c.level === "warn").length;

  const refreshApt = async (node: string) => {
    const r = await api.aptRefresh(node);
    setAptTask({ node, upid: r.upid });
  };

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Saúde</h1>
          <span className="tag">checado {new Date(data.at * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <button className="btn small" onClick={() => refetch()} disabled={isFetching}>{isFetching ? "Checando…" : "Checar de novo"}</button>
      </div>

      <div className="health-sum">
        <div className={`hs ${crit ? "hs-crit" : ""}`}><b>{crit}</b><span>críticos</span></div>
        <div className={`hs ${warn ? "hs-warn" : ""}`}><b>{warn}</b><span>pra ficar de olho</span></div>
        <div className="hs"><b>{data.disks.length}</b><span>discos</span></div>
        <div className="hs"><b>{data.services.filter((s) => s.state === "running").length}/{data.services.length}</b><span>serviços rodando</span></div>
      </div>

      {data.checks.length === 0 ? (
        <div className="all-good">Tudo certo. Nenhum problema encontrado.</div>
      ) : (
        <ul className="checks-list">
          {data.checks.map((c, i) => (
            <li key={i} className={c.level}>
              <span className="lvl">{c.level === "crit" ? "!" : "•"}</span>
              <div>
                <b>{c.title}</b>
                {c.detail && <span>{c.detail}</span>}
              </div>
              <span className="mono muted">{LEVEL[c.level]} · {c.area}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="section">
        <div className="section-head"><h2>Discos</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nó</th><th>Disco</th><th>Modelo</th><th>Tipo</th><th className="num">Tamanho</th><th>SMART</th><th>Desgaste</th><th>Uso</th></tr></thead>
            <tbody>
              {data.disks.map((d) => {
                const bad = !["PASSED", "OK", "UNKNOWN", ""].includes(d.health.toUpperCase());
                return (
                  <tr key={d.node + d.dev} style={{ cursor: "default" }}>
                    <td className="mono">{d.node}</td>
                    <td className="mono">{d.dev}</td>
                    <td>{d.model}</td>
                    <td>{d.type}</td>
                    <td className="num">{bytes(d.size)}</td>
                    <td><span className="status"><span className={`dot ${bad ? "hot" : "running"}`} />{d.health || "—"}</span></td>
                    <td>
                      {d.wearout >= 0 ? (
                        <><span className={`cell-bar ${d.wearout >= 80 ? "hot" : ""}`}><i style={{ width: `${d.wearout}%` }} /></span><span className="mono">{d.wearout}%</span></>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>{d.used}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Atualizações</h2>
            <p>Pacotes pendentes segundo a última consulta do apt em cada nó.</p>
          </div>
        </div>
        <div className="upd-grid">
          {Array.from(new Set(data.services.map((s) => s.node))).map((node) => {
            const u = data.updates.find((x) => x.node === node);
            return (
              <div key={node} className="card upd-card">
                <div className="card-top"><span>{node}</span><span className={`dot ${u ? "paused" : "running"}`} /></div>
                <b>{u ? `${u.count} pacotes` : "Em dia"}</b>
                {u && <span className="mono muted upd-pk">{u.packages.slice(0, 6).join(", ")}{u.packages.length > 6 ? "…" : ""}</span>}
                <div className="ts-row">
                  <button className="btn small" onClick={() => refreshApt(node)}>Procurar</button>
                  {u && settings?.root && (
                    <button className="btn small primary" onClick={() => ui.openConsole({
                      node, kind: "node", title: `Atualizando ${node}`, autorun: " apt-get update && apt-get dist-upgrade",
                    })}>Atualizar no console</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {aptTask && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>apt update em {aptTask.node}</p>
            <TaskLog upid={aptTask.upid} onDone={() => qc.invalidateQueries({ queryKey: ["health"] })} />
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Serviços do Proxmox</h2></div>
        <div className="svc-grid">
          {data.services.map((s) => (
            <div key={s.node + s.name} className="svc" title={s.desc}>
              <span className={`dot ${s.state === "running" ? "running" : "hot"}`} />
              <span className="mono">{s.name}</span>
              <span className="muted">{s.node}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Certificados</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nó</th><th>Arquivo</th><th>Para</th><th>Vence</th></tr></thead>
            <tbody>
              {data.certs.map((c) => {
                const days = Math.round((c.notAfter * 1000 - Date.now()) / 86400000);
                return (
                  <tr key={c.node + c.file} style={{ cursor: "default" }}>
                    <td className="mono">{c.node}</td>
                    <td className="mono">{c.file}</td>
                    <td className="mono">{c.subject.replace(/^\/CN=/, "")}</td>
                    <td><span className="status"><span className={`dot ${days < 0 ? "hot" : days < 21 ? "paused" : "running"}`} />
                      {days < 0 ? "vencido" : `${days} dias`}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

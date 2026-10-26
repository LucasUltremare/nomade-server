import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { bytesPair, num, pct, uptime } from "./format";
import { useHealth } from "./Health";
import { navigate } from "./router";
import { TaskLog } from "./Tasks";
import { useSettings, useStatus, useUI } from "./state";

export type NodeTab = "resumo" | "atualizacoes" | "repositorios";

const TABS: [NodeTab, string][] = [["resumo", "Resumo"], ["atualizacoes", "Atualizações"], ["repositorios", "Repositórios"]];

/** Página de um nó: /nos/{nome}. */
export function NodePage({ name }: { name: string }) {
  const { data: status } = useStatus();
  const [tab, setTab] = useState<NodeTab>("resumo");
  const node = status?.nodes.find((n) => n.name === name);
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <button className="back" onClick={() => navigate("/nos")}>← Nós</button>
          <h1>{name}</h1>
          <span className="tag">{node ? (node.online ? `${node.ip ?? ""} · online` : "offline") : "…"}</span>
        </div>
      </div>
      <div className="seg page-tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "resumo" && <NodeSummary name={name} />}
      {tab === "atualizacoes" && <NodeUpdates name={name} />}
      {tab === "repositorios" && <NodeRepos name={name} />}
    </div>
  );
}

function NodeSummary({ name }: { name: string }) {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: nd } = useQuery({ queryKey: ["node", name], queryFn: () => api.node(name), refetchInterval: 10_000 });
  const [upid, setUpid] = useState("");
  const [armed, setArmed] = useState("");
  const bulk = useMutation({
    mutationFn: (op: "startall" | "stopall") => api.nodeBulk(name, op),
    onSuccess: (r) => { setArmed(""); setUpid(r.upid); },
  });
  if (!nd) return <p className="muted">Carregando…</p>;
  const running = nd.guests.filter((g) => g.status === "running" && !g.template).length;
  const total = nd.guests.filter((g) => !g.template).length;
  return (
    <>
      <div className="health-sum" style={{ marginTop: 18 }}>
        <div className="hs"><b>{pct(Math.round(nd.cpu))}</b><span>CPU · {nd.threads} threads · load {num(parseFloat(nd.load[0] ?? "0"))}</span></div>
        <div className="hs"><b>{bytesPair(nd.memUsed, nd.memTotal)}</b><span>memória</span></div>
        <div className="hs"><b>{uptime(nd.uptime)}</b><span>ligado</span></div>
        <div className="hs"><b>{running}/{total}</b><span>guests rodando</span></div>
      </div>
      <dl className="kv">
        <dt>Processador</dt><dd>{nd.model}</dd>
        <dt>Proxmox VE</dt><dd>{nd.pveVersion}</dd>
        <dt>Kernel</dt><dd>{nd.kernel.split(" ").slice(0, 2).join(" ")}</dd>
        {nd.pool && <><dt>{nd.pool.kind === "zfs" ? "Pool ZFS" : "Storage"}</dt><dd>{nd.pool.name} · {bytesPair(nd.pool.used, nd.pool.total)}</dd></>}
      </dl>
      <div className="dialog-actions">
        <button className="btn" onClick={() => ui.openConsole({ node: name, kind: "node", title: `Shell · ${name}` })}>Abrir shell</button>
        {armed === "startall"
          ? <button className="btn primary" onClick={() => bulk.mutate("startall")}>Confirmar: ligar todos</button>
          : <button className="btn" onClick={() => setArmed("startall")}>Ligar todos os guests</button>}
        {armed === "stopall"
          ? <button className="btn danger" onClick={() => bulk.mutate("stopall")}>Confirmar: desligar todos</button>
          : <button className="btn" onClick={() => setArmed("stopall")}>Desligar todos os guests</button>}
      </div>
      {armed && <p className="muted" style={{ fontSize: 12 }}>Respeita a ordem de boot de cada guest. Desligar é limpo (shutdown), e força depois do tempo limite.</p>}
      {bulk.error && <div className="err">{(bulk.error as Error).message}</div>}
      {upid && <TaskLog key={upid} upid={upid} onDone={() => { for (const k of ["guests", "node", "overview", "status"]) qc.invalidateQueries({ queryKey: [k] }); }} />}
    </>
  );
}

function NodeUpdates({ name }: { name: string }) {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: health, isLoading } = useHealth();
  const { data: settings } = useSettings();
  const [upid, setUpid] = useState("");
  const refresh = useMutation({ mutationFn: () => api.aptRefresh(name), onSuccess: (r) => setUpid(r.upid) });
  const u = health?.updates.find((x) => x.node === name);
  return (
    <div style={{ marginTop: 18 }}>
      <div className="dialog-actions" style={{ marginTop: 0 }}>
        <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>Procurar atualizações</button>
        <button className="btn primary" disabled={!settings?.root}
          title={settings?.root ? undefined : "Só root@pam"}
          onClick={() => ui.openConsole({ node: name, kind: "node", cmd: "upgrade", title: `Atualizando ${name}` })}>
          Atualizar o Proxmox
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        "Atualizar" abre o mesmo terminal de atualização do painel do Proxmox (apt dist-upgrade). Se vier kernel novo, reinicie o nó depois.
      </p>
      {upid && <TaskLog key={upid} upid={upid} onDone={() => qc.invalidateQueries({ queryKey: ["health"] })} />}
      {isLoading && <p className="muted">Carregando…</p>}
      {health && (u ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Pacote pendente</th></tr></thead>
            <tbody>{u.packages.map((p) => <tr key={p} style={{ cursor: "default" }}><td className="mono">{p}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <div className="all-good">Em dia, segundo a última consulta do apt.</div>)}
    </div>
  );
}

function NodeRepos({ name }: { name: string }) {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data, error, isLoading } = useQuery({ queryKey: ["repos", name], queryFn: () => api.repos(name) });
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.repoChange(name, { ...body, digest: data?.digest }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos", name] }),
  });
  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!data) return null;
  const root = settings?.root;
  // Acha a linha de um repositório padrão pra ligar/desligar.
  const find = (handle: string) => {
    const comp = { enterprise: "pve-enterprise", "no-subscription": "pve-no-subscription", test: "pvetest" }[handle];
    for (const f of data.files) {
      const i = f.repositories.findIndex((r) => (comp && r.Components?.includes(comp)) ||
        (handle.startsWith("ceph") && r.URIs.some((u) => u.includes("ceph")) && (handle.endsWith("enterprise") ? r.URIs.some((u) => u.includes("enterprise")) : !r.URIs.some((u) => u.includes("enterprise")))));
      if (i >= 0) return { path: f.path, index: i };
    }
    return null;
  };
  const noSub = data["standard-repos"].find((r) => r.handle === "no-subscription");
  const ent = data["standard-repos"].find((r) => r.handle === "enterprise");

  return (
    <div style={{ marginTop: 18 }}>
      {ent?.status === 1 && noSub?.status !== 1 && root && (
        <div className="warn" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          Sem assinatura, o repositório enterprise falha no apt. O caminho comum em homelab é usar o no-subscription.
          <button className="btn small primary" disabled={change.isPending} onClick={async () => {
            if (noSub?.status === undefined) await api.repoChange(name, { handle: "no-subscription", digest: data.digest });
            const e = find("enterprise");
            if (e) await api.repoChange(name, { ...e, enabled: false });
            qc.invalidateQueries({ queryKey: ["repos", name] });
          }}>Trocar pro no-subscription</button>
        </div>
      )}
      {data.infos?.filter((i) => i.kind === "warning").map((i, n) => <div key={n} className="warn">{i.message}</div>)}
      <div className="repo-grid">
        {data["standard-repos"].map((r) => {
          const loc = find(r.handle);
          const on = r.status === 1;
          return (
            <div key={r.handle} className="card repo">
              <div className="repo-head">
                <b>{r.name}</b>
                <label className="switch" title={!root ? "Só root@pam" : undefined}>
                  <input type="checkbox" checked={on} disabled={!root || change.isPending}
                    onChange={() => (r.status === undefined
                      ? change.mutate({ handle: r.handle })
                      : loc && change.mutate({ ...loc, enabled: !on }))} />
                  <span />
                </label>
              </div>
              <span className="muted">{r.status === undefined ? "não configurado" : on ? "ligado" : "desligado"}</span>
            </div>
          );
        })}
      </div>
      {change.error && <div className="err">{(change.error as Error).message}</div>}
      <div className="hw-title" style={{ marginTop: 22 }}>Todas as fontes</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ativa</th><th>Arquivo</th><th>Endereço</th><th>Versão</th><th>Componentes</th></tr></thead>
          <tbody>
            {data.files.flatMap((f) => f.repositories.map((r, i) => (
              <tr key={f.path + i} style={{ cursor: "default", opacity: r.Enabled ? 1 : 0.55 }}>
                <td><input type="checkbox" checked={!!r.Enabled} disabled={!root} onChange={() => change.mutate({ path: f.path, index: i, enabled: !r.Enabled })} aria-label="Ativa" /></td>
                <td className="mono">{f.path.replace("/etc/apt/", "")}</td>
                <td className="mono">{r.URIs.join(" ")}</td>
                <td className="mono">{r.Suites.join(" ")}</td>
                <td className="mono">{(r.Components ?? []).join(" ")}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

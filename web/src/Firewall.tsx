import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FwRule, type FwScope } from "./api";
import { kindLabel } from "./format";
import { useGuests, useStatus } from "./state";

const scopeKey = (s: FwScope) => ["firewall", JSON.stringify(s)];

export function FirewallPage() {
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const [sel, setSel] = useState("cluster");
  const scope: FwScope = sel === "cluster"
    ? { scope: "cluster" }
    : sel.startsWith("node:")
      ? { scope: "node", node: sel.slice(5) }
      : { scope: "guest", kind: sel.split(":")[1] as "lxc" | "qemu", vmid: +sel.split(":")[2] };
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Firewall</h1>
          <span className="tag">regras do Proxmox em três níveis</span>
        </div>
        <select className="scope-select" value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Nível">
          <option value="cluster">Datacenter (todos os nós)</option>
          <optgroup label="Nós">
            {(status?.nodes ?? []).map((n) => <option key={n.name} value={`node:${n.name}`}>{n.name}</option>)}
          </optgroup>
          <optgroup label="Guests">
            {(guests ?? []).filter((g) => !g.template).map((g) => (
              <option key={g.id} value={`guest:${g.type}:${g.vmid}`}>{kindLabel(g)} {g.vmid} · {g.name}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <p className="lede" style={{ marginTop: 12 }}>
        O datacenter liga o firewall de tudo; nós e guests têm regras próprias por cima. No guest, a placa de rede
        também precisa estar com a opção <span className="mono">firewall=1</span>.
      </p>
      <FirewallPanel key={sel} scope={scope} />
    </div>
  );
}

export function FirewallPanel({ scope }: { scope: FwScope }) {
  const qc = useQueryClient();
  const { data: fw, error, isLoading } = useQuery({ queryKey: scopeKey(scope), queryFn: () => api.firewall(scope) });
  const [adding, setAdding] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [confirmDel, setConfirmDel] = useState(-1);
  const refresh = () => qc.invalidateQueries({ queryKey: scopeKey(scope) });
  const opts = useMutation({
    mutationFn: (b: { enable?: boolean; policyIn?: string; policyOut?: string }) => api.firewallOptions(scope, b),
    onSuccess: () => { setConfirmOn(false); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (r: FwRule) => api.firewallToggle(scope, r.pos, !r.enable), onSuccess: refresh });
  const del = useMutation({ mutationFn: (pos: number) => api.firewallDelete(scope, pos), onSuccess: () => { setConfirmDel(-1); refresh(); } });
  const addMia = useMutation({
    mutationFn: () => api.firewallAdd(scope, { type: "in", action: "ACCEPT", proto: "tcp", dport: String(fw?.miaPort ?? 8443), comment: "Mia", enable: true }),
    onSuccess: refresh,
  });

  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!fw) return null;
  const isCluster = scope.scope === "cluster";
  const lockout = isCluster && !fw.miaPortOpen;
  const anyErr = opts.error || toggle.error || del.error || addMia.error;

  return (
    <div className="fw">
      <div className="fw-opts">
        <div className="fw-switch">
          <span className={`dot ${fw.enable ? "running" : "stopped"}`} />
          <b>{fw.enable ? "Ligado" : "Desligado"}</b>
          {fw.enable ? (
            <button className="btn small" onClick={() => opts.mutate({ enable: false })} disabled={opts.isPending}>Desligar</button>
          ) : confirmOn ? (
            <button className="btn small primary" onClick={() => opts.mutate({ enable: true })} disabled={opts.isPending}>Confirmar</button>
          ) : (
            <button className="btn small" onClick={() => setConfirmOn(true)}>Ligar</button>
          )}
        </div>
        <label>Entrada
          <select value={fw.policyIn} onChange={(e) => opts.mutate({ policyIn: e.target.value })}>
            {["DROP", "REJECT", "ACCEPT"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label>Saída
          <select value={fw.policyOut} onChange={(e) => opts.mutate({ policyOut: e.target.value })}>
            {["ACCEPT", "DROP", "REJECT"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      {lockout && (
        <div className="warn">
          Nenhuma regra libera a porta do Mia ({fw.miaPort}). Com o firewall do datacenter ligado e entrada em DROP, você
          perde o acesso a este painel (o Proxmox só libera 8006 e SSH sozinho).{" "}
          <button className="btn small" onClick={() => addMia.mutate()} disabled={addMia.isPending}>Liberar porta {fw.miaPort}</button>
        </div>
      )}
      {confirmOn && !fw.enable && (
        <div className="warn">
          {isCluster
            ? "Ligar o firewall do datacenter aplica a política de entrada em todos os nós. Confira as regras antes."
            : "Ligar aplica a política de entrada neste nível."}
          {" "}<button className="btn small" onClick={() => setConfirmOn(false)}>Cancelar</button>
        </div>
      )}

      <div className="section-head" style={{ marginTop: 22 }}>
        <h2>Regras</h2>
        <button className="btn small primary" onClick={() => setAdding(!adding)}>{adding ? "Fechar" : "Nova regra"}</button>
      </div>
      {adding && <RuleForm scope={scope} onDone={() => { setAdding(false); refresh(); }} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Ativa</th><th>Direção</th><th>Ação</th><th>Serviço / porta</th><th>Origem</th><th>Destino</th><th>Comentário</th><th /></tr>
          </thead>
          <tbody>
            {fw.rules.map((r) => (
              <tr key={r.pos} style={{ cursor: "default", opacity: r.enable ? 1 : 0.55 }}>
                <td className="mono">{r.pos}</td>
                <td><input type="checkbox" checked={r.enable} onChange={() => toggle.mutate(r)} aria-label="Ativa" /></td>
                <td>{r.type === "in" ? "entrada" : r.type === "out" ? "saída" : "grupo"}</td>
                <td><span className={`fw-action ${r.action.toLowerCase()}`}>{r.action}</span></td>
                <td className="mono">{r.macro || [r.proto, r.dport].filter(Boolean).join(" ") || "qualquer"}</td>
                <td className="mono">{r.source || "qualquer"}</td>
                <td className="mono">{r.dest || "qualquer"}</td>
                <td>{r.comment}</td>
                <td style={{ textAlign: "right" }}>
                  {confirmDel === r.pos
                    ? <button className="btn small danger" onClick={() => del.mutate(r.pos)}>Confirmar</button>
                    : <button className="btn small" onClick={() => setConfirmDel(r.pos)}>Apagar</button>}
                </td>
              </tr>
            ))}
            {!fw.rules.length && <tr><td colSpan={9} className="muted">Nenhuma regra neste nível.</td></tr>}
          </tbody>
        </table>
      </div>
      {anyErr && <div className="err">{(anyErr as Error).message}</div>}
    </div>
  );
}

function RuleForm({ scope, onDone }: { scope: FwScope; onDone: () => void }) {
  const { data: macros } = useQuery({ queryKey: ["fw-macros"], queryFn: api.firewallMacros, staleTime: Infinity });
  const [r, setR] = useState<Partial<FwRule>>({ type: "in", action: "ACCEPT", macro: "", proto: "tcp", dport: "", source: "", dest: "", comment: "", enable: true });
  const set = (k: keyof FwRule, v: string | boolean) => setR((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.firewallAdd(scope, r.macro ? { ...r, proto: "", dport: "" } : r),
    onSuccess: onDone,
  });
  return (
    <form className="fw-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label className="field">Direção
        <select value={r.type} onChange={(e) => set("type", e.target.value)}>
          <option value="in">Entrada</option><option value="out">Saída</option>
        </select>
      </label>
      <label className="field">Ação
        <select value={r.action} onChange={(e) => set("action", e.target.value)}>
          <option>ACCEPT</option><option>DROP</option><option>REJECT</option>
        </select>
      </label>
      <label className="field">Serviço pronto
        <select value={r.macro} onChange={(e) => set("macro", e.target.value)}>
          <option value="">— porta manual —</option>
          {(macros ?? []).map((m) => <option key={m.macro} value={m.macro} title={m.descr}>{m.macro}</option>)}
        </select>
      </label>
      {!r.macro && (
        <>
          <label className="field">Protocolo
            <select value={r.proto} onChange={(e) => set("proto", e.target.value)}>
              <option value="tcp">tcp</option><option value="udp">udp</option><option value="icmp">icmp</option><option value="">qualquer</option>
            </select>
          </label>
          <label className="field">Porta(s)<input value={r.dport} onChange={(e) => set("dport", e.target.value)} placeholder="443 ou 8000:8100" /></label>
        </>
      )}
      <label className="field">Origem<input value={r.source} onChange={(e) => set("source", e.target.value)} placeholder="qualquer, 10.0.10.0/24…" /></label>
      <label className="field">Destino<input value={r.dest} onChange={(e) => set("dest", e.target.value)} placeholder="qualquer" /></label>
      <label className="field">Comentário<input value={r.comment} onChange={(e) => set("comment", e.target.value)} /></label>
      <div className="fw-form-actions">
        <button className="btn primary small" disabled={save.isPending}>Adicionar regra</button>
        {save.error && <span className="err" style={{ margin: 0 }}>{(save.error as Error).message}</span>}
      </div>
    </form>
  );
}

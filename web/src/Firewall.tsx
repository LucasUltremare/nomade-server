import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FwRule, type FwScope } from "./api";
import { pve } from "./Crud";
import { Modal } from "./Dialogs";
import { kindLabel } from "./format";
import { IconX } from "./icons";
import { useGuests, useStatus } from "./state";

const scopeKey = (s: FwScope) => ["firewall", JSON.stringify(s)];

export function FirewallPage() {
  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Firewall</h1>
          <span className="tag">regras do Proxmox em três níveis</span>
        </div>
      </div>
      <div style={{ marginTop: 16 }}><FirewallScoped /></div>
    </div>
  );
}

/** Escolha do nível (datacenter, nó, guest) + as políticas dele. */
export function FirewallScoped() {
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const [sel, setSel] = useState("cluster");
  const scope: FwScope = sel === "cluster"
    ? { scope: "cluster" }
    : sel.startsWith("node:")
      ? { scope: "node", node: sel.slice(5) }
      : { scope: "guest", kind: sel.split(":")[1] as "lxc" | "qemu", vmid: +sel.split(":")[2] };
  return (
    <>
      <div className="fw-scope">
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
        <p className="muted">
          O datacenter liga o firewall de tudo; nós e guests têm regras próprias por cima. No guest, a placa de rede
          também precisa estar com a opção <span className="mono">firewall=1</span>.
        </p>
      </div>
      <FirewallPanel key={sel} scope={scope} />
    </>
  );
}

const scopeLabel = (s: FwScope) => (s.scope === "cluster" ? "datacenter" : s.scope === "node" ? s.node : `${s.kind === "qemu" ? "VM" : "CT"} ${s.vmid}`);

export function FirewallPanel({ scope }: { scope: FwScope }) {
  const qc = useQueryClient();
  const { data: fw, error, isLoading } = useQuery({ queryKey: scopeKey(scope), queryFn: () => api.firewall(scope) });
  const [confirmOn, setConfirmOn] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: scopeKey(scope) });
  const opts = useMutation({
    mutationFn: (b: { enable?: boolean; policyIn?: string; policyOut?: string }) => api.firewallOptions(scope, b),
    onSuccess: () => { setConfirmOn(false); refresh(); },
  });
  const addMia = useMutation({
    mutationFn: () => api.firewallAdd(scope, { type: "in", action: "ACCEPT", proto: "tcp", dport: String(fw?.miaPort ?? 8443), comment: "Mia", enable: true }),
    onSuccess: refresh,
  });

  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!fw) return null;
  const isCluster = scope.scope === "cluster";
  const lockout = isCluster && !fw.miaPortOpen;
  const anyErr = opts.error || addMia.error;

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
      {anyErr && <div className="err">{(anyErr as Error).message}</div>}
      <PolicyTable scope={scope} rules={fw.rules} policyIn={fw.policyIn} policyOut={fw.policyOut} enabled={fw.enable} onChange={refresh} />
    </div>
  );
}

// ---------- tabela de políticas ----------

type Named = { name: string; cidr?: string; comment?: string };

/**
 * Políticas no estilo de firewall de borda: uma seção por direção, cada
 * regra numa linha com origem, destino e serviço em etiquetas, e no fim de
 * cada seção a política padrão (o que acontece com o resto).
 */
function PolicyTable({ scope, rules, policyIn, policyOut, enabled, onChange }: {
  scope: FwScope; rules: FwRule[]; policyIn: string; policyOut: string; enabled: boolean; onChange: () => void;
}) {
  const [view, setView] = useState<"dir" | "seq">("dir");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<FwRule | "new" | null>(null);
  const [confirmDel, setConfirmDel] = useState(-1);
  const { data: aliases } = useQuery({ queryKey: ["fw-aliases"], queryFn: () => pve.get<Named[]>("/cluster/firewall/aliases"), staleTime: 60_000 });
  const { data: ipsets } = useQuery({ queryKey: ["fw-ipsets"], queryFn: () => pve.get<Named[]>("/cluster/firewall/ipset"), staleTime: 60_000 });
  const { data: macros } = useQuery({ queryKey: ["fw-macros"], queryFn: api.firewallMacros, staleTime: Infinity });
  const toggle = useMutation({ mutationFn: (r: FwRule) => api.firewallToggle(scope, r.pos, !r.enable), onSuccess: onChange });
  const move = useMutation({ mutationFn: ([pos, to]: [number, number]) => api.firewallMove(scope, pos, to), onSuccess: onChange });
  const del = useMutation({ mutationFn: (pos: number) => api.firewallDelete(scope, pos), onSuccess: () => { setConfirmDel(-1); onChange(); } });

  const where = scopeLabel(scope);
  const text = (r: FwRule) => [r.comment, r.source, r.dest, r.macro, r.proto, r.dport, r.sport, r.iface, r.action, r.type].join(" ").toLowerCase();
  const shown = rules.filter((r) => !q || text(r).includes(q.toLowerCase()));
  const last = rules.length - 1;

  const addr = (v: string) => {
    if (!v) return <span className="pchip all">todos</span>;
    return v.split(",").map((x) => {
      if (x.startsWith("+")) {
        const name = x.slice(1).replace(/^(dc|guest)\//, "");
        const set = ipsets?.find((s) => s.name === name);
        return <span key={x} className="pchip set" title={`Grupo de IPs${set?.comment ? `: ${set.comment}` : ""}`}><i />{name}</span>;
      }
      const al = aliases?.find((a) => a.name === x.replace(/^(dc|guest)\//, ""));
      if (al) return <span key={x} className="pchip alias" title={`${al.cidr}${al.comment ? ` · ${al.comment}` : ""}`}><i />{al.name}</span>;
      return <span key={x} className="pchip net mono">{x}</span>;
    });
  };
  const service = (r: FwRule) => {
    if (r.macro) {
      const m = macros?.find((x) => x.macro === r.macro);
      return <span className="pchip svc" title={m?.descr}>{r.macro}</span>;
    }
    if (!r.proto && !r.dport) return <span className="pchip all">ALL</span>;
    return (
      <span className="pchip svc mono">
        {(r.proto || "any").toUpperCase()}{r.dport && `/${r.dport}`}{r.sport && ` de ${r.sport}`}
      </span>
    );
  };
  const action = (r: FwRule) =>
    r.type === "group"
      ? <span className="pol-action group">grupo {r.action}</span>
      : <span className={`pol-action ${r.action.toLowerCase()}`}>{r.action === "ACCEPT" ? "✓" : "⊘"} {r.action}</span>;

  const row = (r: FwRule) => (
    <tr key={r.pos} className={r.enable ? "" : "off"} style={{ cursor: "default" }}>
      <td className="mono muted">{r.pos}</td>
      <td>{r.comment || <span className="muted">—</span>}</td>
      <td className="mono">{r.iface || <span className="muted">qualquer</span>}</td>
      <td><div className="pchips">{addr(r.source)}</div></td>
      <td><div className="pchips">{addr(r.dest)}</div></td>
      <td><div className="pchips">{service(r)}</div></td>
      <td>{action(r)}</td>
      <td className="mono">{r.log && r.log !== "nolog" ? r.log : <span className="muted">—</span>}</td>
      <td>
        <label className="switch" title={r.enable ? "Ativa" : "Desligada"}>
          <input type="checkbox" checked={r.enable} onChange={() => toggle.mutate(r)} aria-label={`Regra ${r.pos} ativa`} />
          <span />
        </label>
      </td>
      <td className="row-actions">
        <div>
          <button className="btn small icon" aria-label="Subir" title="Subir (vale antes)" disabled={r.pos === 0 || move.isPending}
            onClick={() => move.mutate([r.pos, r.pos - 1])}>▲</button>
          <button className="btn small icon" aria-label="Descer" title="Descer" disabled={r.pos === last || move.isPending}
            onClick={() => move.mutate([r.pos, r.pos + 2])}>▼</button>
          {r.type !== "group" && <button className="btn small" onClick={() => setEditing(r)}>Editar</button>}
          {confirmDel === r.pos
            ? <button className="btn small danger" onClick={() => del.mutate(r.pos)}>Confirmar</button>
            : <button className="btn small" onClick={() => setConfirmDel(r.pos)}>Apagar</button>}
        </div>
      </td>
    </tr>
  );
  // A política padrão, sempre por último: o que não bateu em nenhuma regra.
  const implicit = (dir: "in" | "out") => {
    const pol = dir === "in" ? policyIn : policyOut;
    return (
      <tr key={`implicit-${dir}`} className="implicit" style={{ cursor: "default" }}>
        <td className="mono muted">—</td>
        <td><i>Política padrão de {dir === "in" ? "entrada" : "saída"}</i></td>
        <td className="muted">qualquer</td>
        <td><span className="pchip all">todos</span></td>
        <td><span className="pchip all">todos</span></td>
        <td><span className="pchip all">ALL</span></td>
        <td><span className={`pol-action ${pol.toLowerCase()}`}>{pol === "ACCEPT" ? "✓" : "⊘"} {pol}</span></td>
        <td className="muted">—</td>
        <td colSpan={2} className="muted" style={{ fontSize: 12 }}>{enabled ? "vale pro que não bateu acima" : "firewall desligado neste nível"}</td>
      </tr>
    );
  };
  const section = (key: string, title: ReactNode, list: FwRule[], dir?: "in" | "out") => {
    const open = !closed.has(key);
    return (
      <tbody key={key}>
        <tr className="group-row" onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
          <td colSpan={10}>
            <button className="group-toggle" aria-expanded={open}>
              <span className="caret">{open ? "▾" : "▸"}</span>{title} <span className="muted">({list.length})</span>
            </button>
          </td>
        </tr>
        {open && list.map(row)}
        {open && dir && !q && implicit(dir)}
      </tbody>
    );
  };

  return (
    <>
      <div className="section-head" style={{ marginTop: 22 }}>
        <h2>Políticas</h2>
        <div className="pol-tools">
          <input className="pol-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar regra…" aria-label="Buscar regra" />
          <div className="seg small" role="group" aria-label="Agrupar">
            <button aria-pressed={view === "dir"} onClick={() => setView("dir")}>Por direção</button>
            <button aria-pressed={view === "seq"} onClick={() => setView("seq")}>Por sequência</button>
          </div>
          <button className="btn small primary" onClick={() => setEditing("new")}>Nova regra</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pol-table">
          <thead>
            <tr><th>#</th><th>Nome</th><th>Interface</th><th>Origem</th><th>Destino</th><th>Serviço</th><th>Ação</th><th>Log</th><th>Ativa</th><th /></tr>
          </thead>
          {view === "dir" ? (
            <>
              {section("in", <>Entrada <span className="pol-flow">qualquer → {where}</span></>, shown.filter((r) => r.type === "in"), "in")}
              {section("out", <>Saída <span className="pol-flow">{where} → qualquer</span></>, shown.filter((r) => r.type === "out"), "out")}
              {shown.some((r) => r.type === "group") && section("group", "Grupos de segurança", shown.filter((r) => r.type === "group"))}
            </>
          ) : (
            <tbody>
              {shown.map(row)}
              {!q && implicit("in")}
              {!q && implicit("out")}
            </tbody>
          )}
        </table>
      </div>
      {!rules.length && <p className="muted" style={{ fontSize: 13 }}>Nenhuma regra neste nível: só a política padrão vale.</p>}
      {(toggle.error || move.error || del.error) && <div className="err">{((toggle.error || move.error || del.error) as Error).message}</div>}
      {editing && (
        <RuleDialog scope={scope} rule={editing === "new" ? null : editing} aliases={aliases ?? []} ipsets={ipsets ?? []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />
      )}
    </>
  );
}

const LOG_LEVELS: [string, string][] = [["", "sem log"], ["info", "info"], ["notice", "notice"], ["warning", "warning"], ["err", "err"], ["debug", "debug"]];

function RuleDialog({ scope, rule, aliases, ipsets, onClose, onSaved }: {
  scope: FwScope; rule: FwRule | null; aliases: Named[]; ipsets: Named[]; onClose: () => void; onSaved: () => void;
}) {
  const { data: macros } = useQuery({ queryKey: ["fw-macros"], queryFn: api.firewallMacros, staleTime: Infinity });
  const [r, setR] = useState<Partial<FwRule>>(rule ?? { type: "in", action: "ACCEPT", macro: "", proto: "tcp", dport: "", sport: "", source: "", dest: "", iface: "", log: "", comment: "", enable: true });
  const set = (k: keyof FwRule, v: string | boolean) => setR((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = r.macro ? { ...r, proto: "", dport: "", sport: "" } : r;
      return rule ? api.firewallEdit(scope, rule.pos, body) : api.firewallAdd(scope, body);
    },
    onSuccess: onSaved,
  });
  const names = [...aliases.map((a) => a.name), ...ipsets.map((s) => `+${s.name}`)];
  return (
    <Modal label={rule ? `Editar regra ${rule.pos}` : "Nova regra"} onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{rule ? `Editar regra ${rule.pos}` : "Nova regra"}</h2>
      <div className="dialog-sub">{scopeLabel(scope)}{!rule && " · regra nova entra no topo (vale antes das outras)"}</div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <label className="field">Nome (comentário)<input value={r.comment} onChange={(e) => set("comment", e.target.value)} placeholder="SSH da LAN" /></label>
          <label className="field">Direção
            <select value={r.type} onChange={(e) => set("type", e.target.value)}>
              <option value="in">Entrada</option><option value="out">Saída</option>
            </select>
          </label>
          <label className="field">Origem<input list="fw-names" value={r.source} onChange={(e) => set("source", e.target.value)} placeholder="todos, lan, +iot, 10.0.10.0/24" /></label>
          <label className="field">Destino<input list="fw-names" value={r.dest} onChange={(e) => set("dest", e.target.value)} placeholder="todos" /></label>
          <label className="field">Serviço pronto
            <select value={r.macro} onChange={(e) => set("macro", e.target.value)}>
              <option value="">— protocolo e porta —</option>
              {(macros ?? []).map((m) => <option key={m.macro} value={m.macro} title={m.descr}>{m.macro}</option>)}
            </select>
          </label>
          {!r.macro ? (
            <>
              <label className="field">Protocolo
                <select value={r.proto} onChange={(e) => set("proto", e.target.value)}>
                  <option value="tcp">tcp</option><option value="udp">udp</option><option value="icmp">icmp</option><option value="">qualquer</option>
                </select>
              </label>
              <label className="field">Porta de destino<input value={r.dport} onChange={(e) => set("dport", e.target.value)} placeholder="443 ou 8000:8100" /></label>
              <label className="field">Porta de origem<input value={r.sport} onChange={(e) => set("sport", e.target.value)} placeholder="(raro)" /></label>
            </>
          ) : <div />}
          <label className="field">Ação
            <select value={r.action} onChange={(e) => set("action", e.target.value)}>
              <option value="ACCEPT">ACCEPT (liberar)</option><option value="DROP">DROP (descartar)</option><option value="REJECT">REJECT (recusar)</option>
            </select>
          </label>
          <label className="field">Interface<input value={r.iface} onChange={(e) => set("iface", e.target.value)} placeholder={scope.scope === "guest" ? "net0" : "vmbr0 (vazio = todas)"} /></label>
          <label className="field">Log
            <select value={r.log} onChange={(e) => set("log", e.target.value)}>
              {LOG_LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
        <datalist id="fw-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        <label className="check"><input type="checkbox" checked={!!r.enable} onChange={(e) => set("enable", e.target.checked)} />Ativa</label>
        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>{rule ? "Salvar" : "Criar regra"}</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NetIface, type TopoGuest } from "./api";
import { Modal } from "./Dialogs";
import { FirewallScoped } from "./Firewall";
import { bps, bytes, linkSpeed } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { Topology } from "./Topology";
import { useSettings, useStatus, useUI } from "./state";

const TYPE_LABEL: Record<string, string> = { bridge: "Bridge", vlan: "VLAN", eth: "Física", bond: "Bond", OVSBridge: "OVS bridge" };

type Tab = "interfaces" | "topologia" | "politicas" | "vpn";
const TABS: [Tab, string][] = [["interfaces", "Interfaces"], ["topologia", "Topologia"], ["politicas", "Políticas"], ["vpn", "VPN"]];

/** Rede do nó: um ponto de onde ver portas, interfaces, topologia e regras. */
export function NetworkPage() {
  const ui = useUI();
  const { data: status } = useStatus();
  const nodes = status?.nodes ?? [];
  const node = ui.node ?? nodes.find((n) => n.online)?.name ?? "";
  const [tab, setTab] = useState<Tab>("interfaces");
  const net = useNetwork(node);
  const topo = useTopology(node, tab === "interfaces" || tab === "topologia");

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Rede</h1>
          <span className="tag">
            {node || "…"}
            {net.data?.traffic.in !== undefined && ` · ↓ ${bytes(net.data.traffic.in)}/s · ↑ ${bytes(net.data.traffic.out ?? 0)}/s`}
          </span>
        </div>
        {tab !== "politicas" && (
          <div className="seg" role="group" aria-label="Nó">
            {nodes.map((n) => (
              <button key={n.name} aria-pressed={n.name === node} disabled={!n.online} onClick={() => ui.setNode(n.name)}>{n.name}</button>
            ))}
          </div>
        )}
      </div>
      <div className="seg page-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === "interfaces" && <InterfacesTab node={node} net={net} guests={topo.data?.guests} />}
      {tab === "topologia" && (
        net.data && topo.data
          ? <Topology node={node} ifaces={net.data.ifaces} guests={topo.data.guests} live={net.data.live} />
          : <p className="muted" style={{ marginTop: 20 }}>{net.error || topo.error ? ((net.error ?? topo.error) as Error).message : "Carregando…"}</p>
      )}
      {tab === "politicas" && <div style={{ marginTop: 20 }}><FirewallScoped /></div>}
      {tab === "vpn" && <TailscaleCard node={node} bridges={(net.data?.ifaces ?? []).filter((i) => i.type === "bridge" && i.cidr)} />}
    </div>
  );
}

const useNetwork = (node: string) =>
  useQuery({ queryKey: ["network", node], queryFn: () => api.network(node), enabled: !!node, refetchInterval: 5_000 });

const useTopology = (node: string, on: boolean) =>
  useQuery({ queryKey: ["topology", node], queryFn: () => api.topology(node), enabled: !!node && on, refetchInterval: 5_000 });

/** Quem usa cada interface: porta numa bridge/bond, VLAN em cima, placas de guest. */
function references(ifaces: NetIface[], guests: TopoGuest[] = []) {
  const owner = new Map<string, string>();
  const refs = new Map<string, string[]>();
  const add = (k: string, who: string) => refs.set(k, [...(refs.get(k) ?? []), who]);
  for (const i of ifaces) {
    if (["bridge", "OVSBridge", "bond"].includes(i.type)) {
      for (const p of i.ports.split(/\s+/).filter(Boolean)) {
        owner.set(p, i.iface);
        add(p, i.iface);
      }
    }
    if (i.type === "vlan" && i.vlanRaw) add(i.vlanRaw, i.iface);
  }
  for (const g of guests) for (const n of g.nics) if (n.bridge) add(n.bridge, `${g.name}${n.tag ? ` (tag ${n.tag})` : ""}`);
  return { owner, refs };
}

// ---------- Interfaces ----------

const GROUPS: [string, string, (i: NetIface) => boolean][] = [
  ["eth", "Portas físicas", (i) => i.type === "eth"],
  ["bond", "Agregadas (bond)", (i) => i.type === "bond"],
  ["bridge", "Bridges", (i) => i.type === "bridge" || i.type === "OVSBridge"],
  ["vlan", "VLANs", (i) => i.type === "vlan"],
  ["other", "Outras", (i) => !["eth", "bond", "bridge", "OVSBridge", "vlan"].includes(i.type)],
];

type Editing = { mode: "new"; type: "bridge" | "vlan" | "bond" } | { mode: "edit"; iface: NetIface };

function InterfacesTab({ node, net, guests }: { node: string; net: ReturnType<typeof useNetwork>; guests?: TopoGuest[] }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = net;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState(false);
  const [applyUpid, setApplyUpid] = useState("");
  const [confirmDel, setConfirmDel] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["network", node] });
  const ifaces = data?.ifaces ?? [];
  const { owner, refs } = useMemo(() => references(ifaces, guests), [ifaces, guests]);

  const apply = useMutation({
    mutationFn: (op: "apply" | "revert") => api.networkApply(node, op),
    onSuccess: (r) => {
      if (r.upid) setApplyUpid(r.upid);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (iface: string) => api.networkDelete(node, iface),
    onSuccess: () => {
      setConfirmDel("");
      refresh();
    },
  });
  const toggleGroup = (k: string) => setClosed((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  return (
    <>
      {data && <Faceplate node={node} ifaces={ifaces} owner={owner} live={data.live} sel={sel} onSel={setSel} />}

      {data?.changes && (
        <div className="pending">
          <div className="pending-head">
            <b>Mudanças pendentes</b>
            <span className="muted">ainda não estão valendo no nó</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn small" onClick={() => apply.mutate("revert")} disabled={apply.isPending}>Descartar</button>
              <button className="btn small primary" onClick={() => apply.mutate("apply")} disabled={apply.isPending}>Aplicar</button>
            </span>
          </div>
          <pre className="diff">{data.changes.split("\n").map((l, i) => (
            <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l}{"\n"}</span>
          ))}</pre>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Aplicar recarrega a rede do nó (ifreload). Errar a bridge principal pode derrubar o acesso: confira antes.
          </p>
        </div>
      )}
      {apply.error && <div className="err">{(apply.error as Error).message}</div>}
      {applyUpid && <div style={{ marginTop: 12 }}><TaskLog upid={applyUpid} onDone={refresh} /></div>}

      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>Interfaces</h2>
        <div className="menu-wrap">
          <button className="btn small primary" aria-expanded={creating} onClick={() => setCreating(!creating)}>Criar nova ▾</button>
          {creating && (
            <div className="menu" role="menu" onMouseLeave={() => setCreating(false)}>
              {(["bridge", "vlan", "bond"] as const).map((t) => (
                <button key={t} role="menuitem" onClick={() => { setCreating(false); setEditing({ mode: "new", type: t }); }}>
                  {t === "bridge" ? "Bridge" : t === "vlan" ? "VLAN" : "Bond (agregar portas)"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && (
        <div className="table-wrap">
          <table className="iface-table">
            <thead>
              <tr><th>Link</th><th>Nome</th><th>Tipo</th><th>Membros</th><th>IP/máscara</th><th>Gateway</th><th>Tráfego</th><th title="Quantas coisas usam a interface">Ref.</th><th>Comentário</th><th /></tr>
            </thead>
            {GROUPS.map(([k, label, match]) => {
              const rows = ifaces.filter(match);
              if (!rows.length) return null;
              const open = !closed.has(k);
              return (
                <tbody key={k}>
                  <tr className="group-row" onClick={() => toggleGroup(k)}>
                    <td colSpan={10}>
                      <button className="group-toggle" aria-expanded={open}>
                        <span className="caret">{open ? "▾" : "▸"}</span>{label} <span className="muted">({rows.length})</span>
                      </button>
                    </td>
                  </tr>
                  {open && rows.map((i) => {
                    const up = i.link?.up ?? i.active;
                    const r = refs.get(i.iface) ?? [];
                    return (
                      <tr key={i.iface} className={sel === i.iface ? "sel" : ""} style={{ cursor: "default" }} onClick={() => setSel(i.iface)}>
                        <td><span className={`link-arrow ${up ? "up" : "down"}`} title={up ? "Link ativo" : "Sem link"}>{up ? "▲" : "▼"}</span></td>
                        <td className="mono">
                          {i.iface}
                          {i.pending && <span className="pend-dot" title="Mudança pendente" />}
                        </td>
                        <td>
                          {TYPE_LABEL[i.type] ?? i.type}
                          {i.vlanAware && <span className="muted"> · vlan-aware</span>}
                          {i.bondMode && <span className="muted"> · {i.bondMode}</span>}
                        </td>
                        <td className="mono">{i.ports || (i.vlanRaw ? `${i.vlanRaw} · tag ${i.vlanId}` : owner.get(i.iface) ? `em ${owner.get(i.iface)}` : "—")}</td>
                        <td className="mono">{i.cidr || "—"}</td>
                        <td className="mono">{i.gateway || "—"}</td>
                        <td><Traffic iface={i} /></td>
                        <td className="mono" title={r.join("\n")}>{r.length || "—"}</td>
                        <td>{i.comments}</td>
                        <td className="row-actions">
                          <div>
                            <button className="btn small" onClick={(e) => { e.stopPropagation(); setEditing({ mode: "edit", iface: i }); }}>Editar</button>
                            {deletable(i) && (confirmDel === i.iface ? (
                              <button className="btn small danger" onClick={(e) => { e.stopPropagation(); del.mutate(i.iface); }} disabled={del.isPending}>Confirmar</button>
                            ) : (
                              <button className="btn small" onClick={(e) => { e.stopPropagation(); setConfirmDel(i.iface); }}>Remover</button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      {del.error && <div className="err">{(del.error as Error).message}</div>}

      {editing && <IfaceDialog node={node} editing={editing} ifaces={ifaces} owner={owner} onClose={() => { setEditing(null); refresh(); }} />}
    </>
  );
}

function Traffic({ iface: i }: { iface: NetIface }) {
  const l = i.link;
  if (!l || l.rx === null || l.tx === null) return <span className="muted">—</span>;
  // Uso do link: o maior sentido sobre a velocidade (full duplex).
  const use = l.speed ? Math.min(1, (Math.max(l.rx, l.tx) * 8) / (l.speed * 1e6)) : 0;
  return (
    <span className="traffic">
      <span className="mono">↓ {bps(l.rx)}</span>
      <span className="mono">↑ {bps(l.tx)}</span>
      {l.speed > 0 && <span className="use-bar" title={`${Math.round(use * 100)}% do link`}><i style={{ width: `${Math.max(2, use * 100)}%` }} /></span>}
    </span>
  );
}

// Placas físicas e a bridge com o gateway (a que dá acesso ao nó) ficam protegidas.
function deletable(i: NetIface) {
  return (i.type === "bridge" || i.type === "vlan" || i.type === "bond") && !i.gateway;
}

// ---------- painel frontal ----------

/**
 * A frente do servidor: uma porta por placa física, acesa quando tem link,
 * com velocidade e o LED de atividade piscando conforme o tráfego.
 */
function Faceplate({ node, ifaces, owner, live, sel, onSel }: {
  node: string; ifaces: NetIface[]; owner: Map<string, string>; live: boolean; sel: string; onSel: (i: string) => void;
}) {
  const ports = ifaces.filter((i) => i.type === "eth").sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
  const upCount = ports.filter((p) => p.link?.up ?? p.active).length;
  return (
    <div className="faceplate-wrap">
      <div className="faceplate" role="group" aria-label={`Portas de ${node}`}>
        <div className="fp-brand">
          <b>{node}</b>
          <span className="mono">Proxmox VE</span>
          <span className="fp-leds"><i className="led on" title="Ligado" />PWR<i className="led on" />STATUS</span>
        </div>
        <div className="fp-ports">
          {ports.map((p, n) => {
            const l = p.link;
            const up = l?.up ?? p.active;
            const sfp = (l?.speed ?? 0) >= 10000;
            const rate = l && l.rx !== null && l.tx !== null ? l.rx + l.tx : 0;
            // Pisca mais rápido com mais tráfego (escala log).
            const blink = rate > 1000 ? Math.max(0.12, 1.1 - Math.log10(rate) * 0.12) : 0;
            const bridge = owner.get(p.iface);
            const via = bridge && owner.get(bridge) ? `${bridge} → ${owner.get(bridge)}` : bridge;
            return (
              <button key={p.iface} className={`fp-port ${up ? "up" : "down"} ${sel === p.iface ? "sel" : ""}`} onClick={() => onSel(p.iface)}
                aria-label={`${p.iface}: ${up ? "com link" : "sem link"}`}>
                <span className="fp-num mono">{n + 1}</span>
                <span className={`fp-jack ${sfp ? "sfp" : ""}`}>
                  <i className="led link" />
                  <i className={`led act ${blink ? "blink" : ""}`} style={blink ? { animationDuration: `${blink}s` } : undefined} />
                </span>
                <span className="fp-name mono">{p.iface}</span>
                <span className="fp-speed mono">{up ? (linkSpeed(l?.speed ?? 0) || "link") : "—"}</span>
                <span className="fp-tip" role="tooltip">
                  <b>{p.iface}</b>{p.comments && <> · {p.comments}</>}
                  <span>Link: {up ? `ativo${l?.speed ? ` · ${l.speed >= 1000 ? `${l.speed / 1000} Gb/s` : `${l.speed} Mb/s`}` : ""}${l?.duplex ? ` · ${l.duplex === "full" ? "full duplex" : l.duplex}` : ""}` : "sem cabo ou desligado"}</span>
                  {l?.mac && <span className="mono">MAC {l.mac}</span>}
                  {l && l.rx !== null && l.tx !== null && <span>↓ {bps(l.rx)} · ↑ {bps(l.tx)}</span>}
                  <span>{via ? `Em uso por ${via}` : "Livre: nenhuma bridge usa"}</span>
                  {!live && <span className="muted">Velocidade e tráfego só aparecem no nó onde a Mia está instalada.</span>}
                </span>
              </button>
            );
          })}
          {!ports.length && <span className="muted" style={{ fontSize: 13 }}>Nenhuma placa física listada.</span>}
        </div>
      </div>
      <div className="fp-legend">
        <span><i className="led on" />{upCount} com link</span>
        <span><i className="led" />{ports.length - upCount} sem link</span>
        <span><i className="led act blink" style={{ animationDuration: "0.4s" }} />atividade</span>
        {!live && <span className="muted">· velocidade só no nó da Mia</span>}
      </div>
    </div>
  );
}

// ---------- criar / editar ----------

const BOND_MODES: [string, string][] = [
  ["active-backup", "active-backup (uma ativa, outra reserva)"],
  ["802.3ad", "802.3ad / LACP (precisa de switch gerenciável)"],
  ["balance-alb", "balance-alb (sem configurar o switch)"],
  ["balance-rr", "balance-rr"],
  ["balance-xor", "balance-xor"],
  ["balance-tlb", "balance-tlb"],
  ["broadcast", "broadcast"],
];

function IfaceDialog({ node, editing, ifaces, owner, onClose }: {
  node: string; editing: Editing; ifaces: NetIface[]; owner: Map<string, string>; onClose: () => void;
}) {
  const cur = editing.mode === "edit" ? editing.iface : null;
  const type = cur ? cur.type : editing.mode === "new" ? editing.type : "bridge";
  const nextName = (prefix: string) => {
    const used = new Set(ifaces.map((i) => i.iface));
    let n = 0;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  const [name, setName] = useState(cur?.iface ?? (type === "bond" ? nextName("bond") : nextName("vmbr")));
  const [cidr, setCidr] = useState(cur?.cidr ?? "");
  const [gateway, setGateway] = useState(cur?.gateway ?? "");
  const [ports, setPorts] = useState<string[]>(cur?.ports.split(/\s+/).filter(Boolean) ?? []);
  const [vlanAware, setVlanAware] = useState(cur?.vlanAware ?? false);
  const [raw, setRaw] = useState(ifaces.find((i) => i.type === "bridge")?.iface ?? "");
  const [vid, setVid] = useState(10);
  const [mode, setMode] = useState(cur?.bondMode || "active-backup");
  const [comments, setComments] = useState(cur?.comments ?? "");
  const self = cur?.iface ?? name;
  // Portas que dá pra usar: físicas (e bonds, numa bridge) livres ou já desta interface.
  const free = ifaces.filter((i) => (i.type === "eth" || (type === "bridge" && i.type === "bond")) && (!owner.get(i.iface) || owner.get(i.iface) === self));
  const mgmt = !!cur?.gateway;

  const save = useMutation({
    mutationFn: () => {
      const body = { type, cidr, gateway, ports: ports.join(" "), vlanAware, bondMode: mode, comments };
      if (cur) return api.networkUpdate(node, cur.iface, body);
      return api.networkCreate(node, type === "vlan" ? { ...body, vlanRaw: raw, vlanId: vid } : { ...body, iface: name });
    },
    onSuccess: onClose,
  });
  const title = cur ? `Editar ${cur.iface}` : type === "bridge" ? "Nova bridge" : type === "vlan" ? "Nova VLAN" : "Novo bond";
  const togglePort = (p: string) => setPorts((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]));

  return (
    <Modal label={title} onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{title}</h2>
      <div className="dialog-sub">{node} · {TYPE_LABEL[type] ?? type} · fica pendente até você aplicar</div>
      {mgmt && <div className="warn">Esta interface tem o gateway: é por ela que você acessa o nó e a Mia. Errar o IP aqui derruba o acesso.</div>}
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          {!cur && type !== "vlan" && <label className="field">Nome<input value={name} onChange={(e) => setName(e.target.value)} /></label>}
          {!cur && type === "vlan" && (
            <>
              <label className="field">
                Interface base
                <select value={raw} onChange={(e) => setRaw(e.target.value)}>
                  {ifaces.filter((i) => ["bridge", "eth", "bond"].includes(i.type)).map((i) => <option key={i.iface}>{i.iface}</option>)}
                </select>
              </label>
              <label className="field">Tag (1–4094)<input type="number" min={1} max={4094} value={vid} onChange={(e) => setVid(+e.target.value)} /></label>
            </>
          )}
          {type === "bond" && (
            <label className="field">Modo
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                {BOND_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          )}
          {(type === "bridge" || type === "bond") && (
            <div className="field span2">
              {type === "bridge" ? "Portas (vazio = rede interna, sem sair do nó)" : "Placas do bond"}
              <div className="chip-picks">
                {free.map((i) => (
                  <label key={i.iface} className={`pick ${ports.includes(i.iface) ? "on" : ""}`}>
                    <input type="checkbox" checked={ports.includes(i.iface)} onChange={() => togglePort(i.iface)} />
                    <span className="mono">{i.iface}</span>
                    {i.link?.speed ? <small className="muted"> {linkSpeed(i.link.speed)}</small> : null}
                  </label>
                ))}
                {!free.length && <span className="muted" style={{ fontSize: 13 }}>Nenhuma porta livre.</span>}
              </div>
            </div>
          )}
          <label className="field">IP/prefixo <small className="muted">(opcional)</small><input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.30.1/24" /></label>
          <label className="field">Gateway <small className="muted">(só uma por nó)</small><input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="10.0.30.254" /></label>
          <label className="field span2">Comentário<input value={comments} onChange={(e) => setComments(e.target.value)} /></label>
        </div>
        {type === "bridge" && (
          <label className="check"><input type="checkbox" checked={vlanAware} onChange={(e) => setVlanAware(e.target.checked)} />VLAN aware (guests escolhem a VLAN pela tag)</label>
        )}
        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>{cur ? "Salvar" : "Criar"}</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- VPN ----------

function TailnetField() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (t: string) => api.setTailnet(t), onSuccess: (s) => { qc.setQueryData(["settings"], s); setV(null); } });
  if (!settings?.root) return null;
  const cur = settings.tailscale.tailnet;
  return (
    <form className="ts-row" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); save.mutate(v ?? cur); }}>
      <input value={v ?? cur} onChange={(e) => setV(e.target.value)} placeholder="sua-tailnet.ts.net" aria-label="Domínio da tailnet" />
      <button className="btn small" disabled={v === null || v === cur || save.isPending}>Salvar</button>
      {save.error && <span className="err" style={{ margin: 0 }}>{(save.error as Error).message}</span>}
    </form>
  );
}

function TailscaleCard({ node, bridges }: { node: string; bridges: NetIface[] }) {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: status } = useStatus();
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [bridge, setBridge] = useState("");
  const [name, setName] = useState("homelab-gw");
  const [err, setErr] = useState("");
  const saveKey = useMutation({
    mutationFn: (k: string) => api.setTailscaleKey(k),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      setKey("");
      setEditing(false);
    },
  });
  const br = bridge || bridges[0]?.iface || "";
  const root = settings?.root;
  const configured = settings?.tailscale.configured;

  const createGateway = async () => {
    setErr("");
    try {
      const r = await api.tailscaleCommand({ action: "gateway", node, bridge: br, hostname: name });
      ui.openConsole({ node, kind: "node", title: "Gateway Tailscale", autorun: r.command });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>VPN · Tailscale</h2>
          <p>Acesse o homelab de qualquer lugar. O host {status?.tailscale ? `está ${status.tailscale}` : "não tem Tailscale"} no momento.</p>
        </div>
      </div>
      <div className="ts-grid">
        <div className="card ts-card">
          <b>1. Auth key</b>
          <p>
            Crie uma chave <b>reutilizável</b> em{" "}
            <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">login.tailscale.com → Keys</a>.
            O Mia usa ela pra colocar o gateway e os apps na sua tailnet.
          </p>
          {!root ? (
            <p className="muted">Só root@pam configura.</p>
          ) : configured && !editing ? (
            <div className="ts-row">
              <span className="mono">{settings?.tailscale.hint}</span>
              <button className="btn small" onClick={() => setEditing(true)}>Trocar</button>
              <button className="btn small danger" onClick={() => saveKey.mutate("")}>Remover</button>
            </div>
          ) : (
            <form className="ts-row" onSubmit={(e) => { e.preventDefault(); saveKey.mutate(key); }}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tskey-auth-…" aria-label="Auth key" />
              <button className="btn small primary" disabled={!key || saveKey.isPending}>Salvar</button>
            </form>
          )}
          {saveKey.error && <div className="err">{(saveKey.error as Error).message}</div>}
        </div>

        <div className="card ts-card">
          <b>2. Gateway pronto</b>
          <p>
            Cria um LXC Debian leve com Tailscale como <i>subnet router</i>: tudo que estiver na rede da bridge fica
            acessível pela VPN, inclusive o que você subir depois.
          </p>
          <div className="ts-row">
            <select value={br} onChange={(e) => setBridge(e.target.value)} aria-label="Bridge">
              {bridges.map((b) => <option key={b.iface} value={b.iface}>{b.iface} · {b.cidr}</option>)}
            </select>
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} aria-label="Nome na tailnet" style={{ maxWidth: 150 }} />
            <button className="btn small primary" disabled={!root || !configured || !br} onClick={createGateway}>Criar gateway</button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Depois aprove a rota no admin do Tailscale (ou use autoApprovers na ACL).</p>
        </div>

        <div className="card ts-card">
          <b>3. Apps com endereço próprio</b>
          <TailnetField />
          <p>
            Na loja de apps marque <i>Publicar no Tailscale</i>, ou abra um contêiner e use <i>Expor no Tailscale</i>.
            Ele ganha <span className="mono">https://nome.sua-tailnet.ts.net</span> com certificado.
          </p>
          <p className="muted" style={{ fontSize: 12 }}>Precisa de HTTPS ligado em DNS no admin do Tailscale.</p>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

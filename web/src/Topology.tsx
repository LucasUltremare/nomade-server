import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NetIface, TopoGuest } from "./api";
import { bps, linkSpeed } from "./format";
import { IconShield } from "./icons";
import { useUI } from "./state";

// Medidas do desenho (px).
const ROW = 66; // altura de cada linha de guest
const NODE = 56; // altura de um cartão
const MID = NODE / 2;
const LINE = 16; // cada linha a mais no cartão da bridge (comentário, VLAN)
const GAP = 22; // entre blocos de bridge
const PAD = 16;
const W = { router: 150, port: 150, bridge: 190, guest: 240 };
const MIN_WIDTH = 940;

interface Box { x: number; y: number }
interface Edge {
  id: string;
  a: Box;
  b: Box;
  rate: number; // bytes/s
  dashed: boolean;
  label?: string;
  fw?: boolean;
  owner?: string; // guest ou porta, pra destacar no hover
}

/**
 * Mapa da rede do nó, da esquerda pra direita: o roteador (gateway), as
 * portas físicas, as bridges e os guests ligados em cada uma. A linha
 * engrossa e "corre" mais rápido com mais tráfego; tracejada é desligado
 * ou sem link.
 */
export function Topology({ node, ifaces, guests, live }: { node: string; ifaces: NetIface[]; guests: TopoGuest[]; live: boolean }) {
  const ui = useUI();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MIN_WIDTH);
  const [hover, setHover] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(MIN_WIDTH, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const map = useMemo(() => layout(ifaces, guests, width), [ifaces, guests, width]);
  const linkUp = ifaces.filter((i) => i.type === "eth" && (i.link?.up ?? i.active)).length;
  const eths = ifaces.filter((i) => i.type === "eth").length;
  const running = guests.filter((g) => g.status === "running");
  const sum = (k: "rx" | "tx") => running.reduce((t, g) => t + (g[k] ?? 0), 0);

  return (
    <div className="topo">
      <div className="topo-summary">
        <span><b>{guests.length}</b> guests ({running.length} ligados)</span>
        <span><b>{map.bridges.length}</b> bridges</span>
        <span><b>{linkUp}</b>/{eths} portas com link</span>
        <span className="mono">guests ↓ {bps(sum("rx"))} · ↑ {bps(sum("tx"))}</span>
        <span className="topo-legend">
          <i className="lg flow" />tráfego
          <i className="lg dashed" />desligado / sem link
          <IconShield width={12} height={12} />firewall na placa
        </span>
      </div>
      <div className="topo-scroll" ref={box}>
        <div className="topo-canvas" style={{ width: map.width, height: map.height }}>
          <svg width={map.width} height={map.height} aria-hidden="true">
            {map.edges.map((e) => {
              const mx = (e.a.x + e.b.x) / 2;
              const d = `M${e.a.x},${e.a.y} C${mx},${e.a.y} ${mx},${e.b.y} ${e.b.x},${e.b.y}`;
              const flow = !e.dashed && e.rate > 1000;
              const w = 1.4 + Math.min(4, Math.log10(1 + e.rate / 2000));
              const dur = Math.min(3, Math.max(0.35, 3.4 - Math.log10(Math.max(e.rate, 1)) * 0.42));
              const dim = hover !== null && e.owner !== hover;
              return (
                <g key={e.id} className={`topo-edge ${e.dashed ? "dashed" : ""} ${dim ? "dim" : ""}`}>
                  <path d={d} className="base" strokeWidth={w} />
                  {flow && <path d={d} className="flow" strokeWidth={w} style={{ animationDuration: `${dur}s` }} />}
                </g>
              );
            })}
          </svg>
          {/* Rótulos das linhas (VLAN, firewall) ficam no meio da curva. */}
          {map.edges.filter((e) => e.label || e.fw).map((e) => (
            <span key={`l-${e.id}`} className={`topo-chip ${hover !== null && e.owner !== hover ? "dim" : ""}`}
              style={{ left: (e.a.x + e.b.x) / 2, top: (e.a.y + e.b.y) / 2 }}>
              {e.fw && <IconShield width={11} height={11} />}{e.label}
            </span>
          ))}

          {map.router && (
            <div className="topo-node router" style={{ left: map.router.x, top: map.router.y, width: W.router }}>
              <span className="topo-kicker">Internet</span>
              <b>Roteador</b>
              <span className="mono">{map.router.gateway}</span>
            </div>
          )}
          {map.ports.map((p) => (
            <div key={p.iface.iface} className={`topo-node port ${p.up ? "up" : "down"} ${hover !== null && hover !== p.iface.iface ? "dim" : ""}`}
              style={{ left: p.x, top: p.y, width: W.port }} onMouseEnter={() => setHover(p.iface.iface)} onMouseLeave={() => setHover(null)}>
              <span className="topo-kicker"><i className={`led ${p.up ? "on" : ""}`} />{p.iface.type === "bond" ? `bond · ${p.iface.bondMode}` : "porta física"}</span>
              <b className="mono">{p.iface.iface}</b>
              <span className="mono">
                {p.iface.type === "bond" ? p.iface.ports : p.up ? (linkSpeed(p.iface.link?.speed ?? 0) || "link") : "sem link"}
                {p.rate > 0 && ` · ${bps(p.rate)}`}
              </span>
            </div>
          ))}
          {map.bridges.map((b) => (
            <div key={b.iface.iface} className="topo-node bridge" style={{ left: b.x, top: b.y, width: W.bridge, height: b.h }}>
              <span className="topo-kicker">bridge{b.iface.vlanAware ? " · vlan-aware" : ""}</span>
              <b className="mono">{b.iface.iface}</b>
              <span className="mono">{b.iface.cidr || "sem IP no host"}</span>
              {b.iface.comments && <span className="topo-note">{b.iface.comments}</span>}
              {b.vlans.map((v) => <span key={v.iface} className="topo-vlan mono">VLAN {v.vlanId}{v.cidr && ` · ${v.cidr}`}</span>)}
            </div>
          ))}
          {map.guests.map((g) => (
            <button key={g.g.id} className={`topo-node guest ${g.g.status === "running" ? "" : "off"} ${hover !== null && hover !== g.g.id ? "dim" : ""}`}
              style={{ left: g.x, top: g.y, width: W.guest }} onMouseEnter={() => setHover(g.g.id)} onMouseLeave={() => setHover(null)}
              onClick={() => ui.openGuest(g.g.id)}>
              <span className="topo-kicker">
                <span className={`dot ${g.g.status === "running" ? "running" : "stopped"}`} />
                {g.g.type === "qemu" ? "VM" : "LXC"} {g.g.vmid}
              </span>
              <b>{g.g.name}</b>
              <span className="mono">
                {g.g.ip || (g.g.status === "running" ? "IP desconhecido" : "desligado")}
                {g.g.rx !== null && g.g.tx !== null && g.g.status === "running" && ` · ${bps(g.g.rx + g.g.tx)}`}
              </span>
            </button>
          ))}
          {!guests.length && !map.bridges.length && <p className="muted" style={{ padding: 20 }}>Nada pra desenhar em {node}.</p>}
        </div>
      </div>
      {!live && <p className="muted" style={{ fontSize: 12 }}>Tráfego e velocidade das portas aparecem só no nó onde a Mia está instalada; aqui as portas mostram o estado do Proxmox.</p>}
    </div>
  );
}

function layout(ifaces: NetIface[], guests: TopoGuest[], width: number) {
  const byName = new Map(ifaces.map((i) => [i.iface, i]));
  const num = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const bridges = ifaces.filter((i) => i.type === "bridge" || i.type === "OVSBridge").sort((a, b) => num(a.iface, b.iface));
  const members = (i: NetIface) => i.ports.split(/\s+/).filter(Boolean);
  // Bond tem link se alguma placa dele tem.
  const upOf = (i: NetIface): boolean =>
    i.type === "bond" ? members(i).some((m) => { const x = byName.get(m); return !!x && upOf(x); }) : (i.link?.up ?? i.active);
  const rateOf = (i?: NetIface) => (i?.link && i.link.rx !== null && i.link.tx !== null ? i.link.rx + i.link.tx : 0);

  // Colunas: espaço que sobra dividido igual entre os vãos.
  const gap = (width - PAD * 2 - W.router - W.port - W.bridge - W.guest) / 3;
  const X = { router: PAD, port: PAD + W.router + gap, bridge: PAD + W.router + W.port + gap * 2, guest: width - PAD - W.guest };

  // Cada guest fica no bloco da bridge da primeira placa.
  const home = new Map<string, TopoGuest[]>();
  const loose: TopoGuest[] = [];
  for (const g of guests) {
    const b = g.nics.find((n) => byName.has(n.bridge))?.bridge;
    if (b) home.set(b, [...(home.get(b) ?? []), g]);
    else loose.push(g);
  }

  let y = PAD;
  const out = {
    width,
    height: 0,
    router: null as null | (Box & { gateway: string }),
    ports: [] as (Box & { iface: NetIface; up: boolean; rate: number })[],
    bridges: [] as (Box & { iface: NetIface; vlans: NetIface[]; h: number })[],
    guests: [] as (Box & { g: TopoGuest })[],
    edges: [] as Edge[],
  };
  const center = new Map<string, number>(); // nome → y do centro
  const placedPorts = new Set<string>();

  const placeGuests = (list: TopoGuest[], top: number) => {
    list.forEach((g, i) => {
      const gy = top + i * ROW;
      out.guests.push({ g, x: X.guest, y: gy });
      center.set(g.id, gy + MID);
    });
  };

  for (const b of bridges) {
    const gs = home.get(b.iface) ?? [];
    // Portas da bridge (e as placas dos bonds dela) ficam na mesma altura.
    const ports = members(b).map((p) => byName.get(p)).filter((p): p is NetIface => !!p);
    const vlans = ifaces.filter((v) => v.type === "vlan" && v.vlanRaw === b.iface);
    // O cartão da bridge cresce com comentário e VLANs; o bloco acompanha.
    const h = NODE + LINE * ((b.comments ? 1 : 0) + vlans.length);
    const rows = Math.max(1, gs.length, ports.length, Math.ceil((h + ROW - NODE) / ROW));
    const top = y;
    const by = top + (rows * ROW - (ROW - NODE)) / 2 - h / 2;
    out.bridges.push({ iface: b, vlans, h, x: X.bridge, y: by });
    center.set(b.iface, by + h / 2);
    const portTop = top + ((rows - ports.length) * ROW) / 2;
    ports.forEach((p, i) => {
      out.ports.push({ iface: p, up: upOf(p), rate: rateOf(p), x: X.port, y: portTop + i * ROW });
      center.set(p.iface, portTop + i * ROW + MID);
      placedPorts.add(p.iface);
      // O nó do bond já lista as placas dele.
      if (p.type === "bond") members(p).forEach((m) => placedPorts.add(m));
    });
    placeGuests(gs, top + ((rows - gs.length) * ROW) / 2);
    y = top + rows * ROW + GAP;
  }
  // Portas que nenhuma bridge usa (e placas de bond) vêm embaixo.
  for (const p of ifaces.filter((i) => i.type === "eth" || i.type === "bond").sort((a, b) => num(a.iface, b.iface))) {
    if (placedPorts.has(p.iface)) continue;
    out.ports.push({ iface: p, up: upOf(p), rate: rateOf(p), x: X.port, y });
    center.set(p.iface, y + MID);
    if (p.type === "bond") members(p).forEach((m) => placedPorts.add(m));
    y += ROW;
  }
  if (loose.length) {
    placeGuests(loose, y);
    y += loose.length * ROW;
  }
  out.height = Math.max(y + PAD, 200);

  // Roteador: na altura da porta que leva à bridge com o gateway.
  const gw = bridges.find((b) => b.gateway);
  if (gw) {
    const uplink = members(gw)[0];
    const up = byName.get(uplink);
    const gy = (center.get(uplink) ?? center.get(gw.iface) ?? 40) - MID;
    out.router = { x: X.router, y: gy, gateway: gw.gateway };
    out.edges.push({
      id: "wan", a: { x: X.router + W.router, y: gy + MID }, b: up ? { x: X.port, y: center.get(uplink)! } : { x: X.bridge, y: center.get(gw.iface)! },
      rate: rateOf(up), dashed: !!up && !upOf(up), owner: uplink,
    });
  }

  // Porta (ou bond) → bridge.
  for (const p of out.ports) {
    for (const b of bridges.filter((b) => members(b).includes(p.iface.iface))) {
      out.edges.push({ id: `${p.iface.iface}-${b.iface}`, a: { x: X.port + W.port, y: center.get(p.iface.iface)! },
        b: { x: X.bridge, y: center.get(b.iface)! }, rate: p.rate, dashed: !p.up, owner: p.iface.iface });
    }
  }

  // Bridge → guest, uma linha por placa.
  for (const { g } of out.guests) {
    const on = g.status === "running";
    for (const n of g.nics) {
      const by = center.get(n.bridge);
      if (by === undefined) continue;
      const rate = on && g.rx !== null && g.tx !== null ? (g.rx + g.tx) / Math.max(1, g.nics.length) : 0;
      out.edges.push({ id: `${g.id}-${n.key}`, a: { x: X.bridge + W.bridge, y: by }, b: { x: X.guest, y: center.get(g.id)! },
        rate, dashed: !on || n.down, label: n.tag ? `tag ${n.tag}` : undefined, fw: n.firewall, owner: g.id });
    }
  }
  return out;
}

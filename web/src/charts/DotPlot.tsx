import { useMemo, useState } from "react";
import type { Guest, GuestSamples } from "../api";
import { HOT, IDLE, bytes, clock, kindLabel, pct } from "../format";
import { IconX } from "../icons";
import { useWidth } from "./useSize";

const COLS = 50; // colunas de 2%
const MAX_ROWS = 9;

type Cat = "idle" | "normal" | "crit";

export interface Bins {
  counts: number[];
  byGuest: Map<string, number>[];
  perDot: number; // amostras representadas por cada ponto
  clipped: boolean; // alguma coluna passou do topo
  total: number;
  peak: { id: string; name: string; cpu: number; t: number; mem: number } | null;
}

const catOf = (col: number): Cat => {
  const center = col * 2 + 1;
  return center < IDLE ? "idle" : center >= HOT ? "crit" : "normal";
};

/** Agrupa todas as amostras de CPU dos guests em colunas de 2%. */
export function binSamples(samples: GuestSamples[]): Bins {
  const counts = new Array(COLS).fill(0);
  const byGuest = counts.map(() => new Map<string, number>());
  let total = 0;
  let peak: Bins["peak"] = null;
  for (const s of samples) {
    s.cpu.forEach((v, i) => {
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(v / 2)));
      counts[col]++;
      byGuest[col].set(s.name, (byGuest[col].get(s.name) ?? 0) + 1);
      total++;
      if (!peak || v > peak.cpu) peak = { id: s.id, name: s.name, cpu: v, t: s.t[i], mem: s.mem[i] };
    });
  }
  // A escala sai do percentil 85 das colunas, não do máximo: guest ocioso
  // gera uma coluna gigante perto do 0% que achataria todo o resto. Coluna
  // que passa do topo é cortada e ganha um anel no último ponto.
  const nz = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const ref = nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.85))] : 1;
  const perDot = Math.max(1, Math.ceil(ref / (MAX_ROWS - 1)));
  const clipped = counts.some((c) => Math.ceil(c / perDot) > MAX_ROWS);
  return { counts, byGuest, perDot, clipped, total, peak };
}

export function DotPlot({ bins, guests, onOpenGuest }: {
  bins: Bins;
  guests: Guest[];
  onOpenGuest: (id: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const cw = width / COLS;
  const pitch = Math.max(6, Math.min(12, cw * 0.95));
  const r = pitch * 0.34;
  const plotH = MAX_ROWS * pitch + 4;
  const H = plotH + 26;

  const dots = useMemo(() => {
    const out: { x: number; y: number; cat: Cat; key: string; ring: boolean }[] = [];
    bins.counts.forEach((c, col) => {
      const full = c ? Math.ceil(c / bins.perDot) : 0;
      const n = Math.min(MAX_ROWS, full);
      for (let row = 0; row < n; row++) {
        out.push({ x: (col + 0.5) * cw, y: plotH - pitch / 2 - row * pitch, cat: catOf(col), key: `${col}-${row}`,
          ring: full > MAX_ROWS && row === n - 1 });
      }
    });
    return out;
  }, [bins, cw, pitch, plotH]);

  const peak = bins.peak;
  const peakKey = peak ? `${peak.id}@${peak.t}` : null;
  const peakGuest = peak ? guests.find((g) => g.id === peak.id) : undefined;
  const showPeak = peak && peak.cpu >= HOT && dismissed !== peakKey && width > 0;
  const peakCol = peak ? Math.min(COLS - 1, Math.floor(peak.cpu / 2)) : 0;
  // O popover fica à esquerda da coluna do pico pra não cobrir os pontos críticos.
  const peakX = (peakCol + 0.5) * cw;
  const popLeft = peakX - 196 - 14 >= 0 ? peakX - 196 - 14 : Math.min(peakX + 14, width - 196);

  const ticks = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const summary = `Distribuição de ${bins.total} amostras de CPU de guests: ` +
    `${bins.counts.slice(0, IDLE / 2).reduce((a, b) => a + b, 0)} ociosas, ` +
    `${bins.counts.slice(HOT / 2).reduce((a, b) => a + b, 0)} críticas.`;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={summary}>
          <g>
            {dots.map((d) => (
              <circle key={d.key} cx={d.x} cy={d.y} r={d.ring ? r - 0.75 : r}
                fill={d.ring ? "none" : `var(--c-${d.cat})`} stroke={d.ring ? `var(--c-${d.cat})` : "none"} strokeWidth={1.5}
                opacity={hover === null || Math.floor(d.x / cw) === hover ? 1 : 0.35} />
            ))}
          </g>
          <line x1={0} x2={width} y1={plotH + 1} y2={plotH + 1} stroke="var(--ink)" strokeWidth={1} />
          <g className="axis">
            {ticks.map((t, i) => (
              <text key={t} x={(t / 100) * width} y={plotH + 20}
                textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
                {t === 0 ? "0%" : t === 100 ? "100%" : t}
              </text>
            ))}
          </g>
          {bins.counts.map((c, col) => (
            <rect key={col} x={col * cw} y={0} width={cw} height={plotH} fill="transparent"
              onMouseEnter={() => setHover(c ? col : null)} />
          ))}
        </svg>
      )}

      {hover !== null && bins.counts[hover] > 0 && (
        <div className="tip" style={{ left: (hover + 0.5) * cw, top: plotH - Math.min(MAX_ROWS, Math.ceil(bins.counts[hover] / bins.perDot)) * pitch }}>
          <div className="mono">{hover * 2}–{hover * 2 + 2}% CPU · {bins.counts[hover]} amostras</div>
          {[...bins.byGuest[hover].entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => (
            <div className="tip-row" key={name}>{name} <span className="muted">×{n}</span></div>
          ))}
        </div>
      )}

      {showPeak && (
        <div className="pop" style={{ left: popLeft, top: -14 }} role="status">
          <span className="badge">↑ {pct(Math.round(peak.cpu))} CPU</span>
          <button className="close" aria-label="Fechar" onClick={() => setDismissed(peakKey)}><IconX width={14} height={14} /></button>
          <b>Pico detectado</b>
          <div>{peakGuest ? `${kindLabel(peakGuest)} ${peakGuest.vmid} · ` : ""}{peak.name}{peakGuest ? ` · ${peakGuest.node}` : ""}</div>
          <div>{clock(peak.t, true)}{peak.mem ? ` · ${bytes(peak.mem)} RAM` : ""}</div>
          <button className="link" onClick={() => onOpenGuest(peak.id)}>Ver guest →</button>
        </div>
      )}
    </div>
  );
}

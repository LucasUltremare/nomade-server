import { useMemo, useState } from "react";
import type { Overview, Range } from "../api";
import { clock, pct } from "../format";
import { useWidth } from "./useSize";

const PLOT_H = 180;
const TOP = 8;
const AXIS_W = 40; // rótulos do eixo y à direita
const H = TOP + PLOT_H + 28;

/** Linha com quebras onde o rrd ficou sem dado (nó fora do ar, etc.). */
function path(ts: number[], vs: number[], x: (t: number) => number, y: (v: number) => number) {
  if (!ts.length) return "";
  const steps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)] ?? 0;
  let d = "";
  ts.forEach((t, i) => {
    const gap = i > 0 && step > 0 && t - ts[i - 1] > step * 3;
    d += `${i === 0 || gap ? "M" : "L"}${x(t).toFixed(1)},${y(vs[i]).toFixed(1)}`;
  });
  return d;
}

function xTicks(from: number, to: number, range: Range) {
  const out: { t: number; label: string }[] = [];
  const d = new Date(from * 1000);
  if (range === "24h") {
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / 4) * 4);
    for (let t = d.getTime() / 1000; t <= to; t += 4 * 3600) {
      out.push({ t, label: `${String(new Date(t * 1000).getHours()).padStart(2, "0")}h` });
    }
  } else {
    d.setHours(24, 0, 0, 0);
    const every = range === "7d" ? 1 : 5;
    for (let t = d.getTime() / 1000; t <= to; t += every * 86400) {
      const dt = new Date(t * 1000);
      out.push({
        t,
        label: range === "7d"
          ? dt.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")
          : dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      });
    }
  }
  return out;
}

export function Trend({ ov }: { ov: Overview }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { trend, from, to, range } = ov;
  const plotW = Math.max(0, width - AXIS_W);

  const x = (t: number) => ((t - from) / (to - from)) * plotW;
  const y = (v: number) => TOP + (1 - Math.min(100, Math.max(0, v)) / 100) * PLOT_H;

  const lines = useMemo(() => ({
    cpu: path(trend.t, trend.cpu, x, y),
    ram: path(trend.t, trend.ram, x, y),
  }), [trend, plotW, from, to]); // x/y derivam só disso

  const ticks = useMemo(() => xTicks(from, to, range), [from, to, range]);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!trend.t.length) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const t = from + (px / plotW) * (to - from);
    let best = 0;
    trend.t.forEach((tt, i) => {
      if (Math.abs(tt - t) < Math.abs(trend.t[best] - t)) best = i;
    });
    setHover(best);
  };

  const peak = trend.peak;
  const inBackup = (t: number) => trend.backups.some(([a, b]) => t >= a && t <= b);
  const hx = hover !== null ? x(trend.t[hover]) : 0;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img"
          aria-label={`CPU e RAM do cluster. CPU média ${pct(ov.load.avg)}${peak ? `, pico de ${pct(peak.cpu)} ${clock(peak.t, true)}` : ""}.`}>
          <defs>
            <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="var(--c-hatch)" strokeWidth="1.5" />
            </pattern>
          </defs>

          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
              <text className="axis" x={width} y={y(v) + 4} textAnchor="end"
                style={{ fontFamily: "var(--mono)", fontSize: 11, fill: "var(--ink-3)" }}>
                {v === 0 ? "0%" : v}
              </text>
            </g>
          ))}

          {trend.backups.map(([a, b]) => (
            <g key={a}>
              <rect x={x(a)} y={TOP} width={Math.max(2, x(b) - x(a))} height={PLOT_H} fill="url(#hatch)" />
              <line x1={x(a)} x2={x(a)} y1={TOP} y2={TOP + PLOT_H} stroke="var(--c-cpu)" strokeWidth={1} opacity={0.7} />
              <line x1={x(b)} x2={x(b)} y1={TOP} y2={TOP + PLOT_H} stroke="var(--c-cpu)" strokeWidth={1} opacity={0.7} />
            </g>
          ))}

          <path d={lines.ram} fill="none" stroke="var(--c-ram)" strokeWidth={1.5} strokeLinejoin="round" />
          <path d={lines.cpu} fill="none" stroke="var(--c-cpu)" strokeWidth={2} strokeLinejoin="round" />

          {peak && hover === null && (
            <circle cx={x(peak.t)} cy={y(peak.cpu)} r={4} fill="var(--c-cpu)" stroke="var(--bg)" strokeWidth={2} />
          )}

          <g className="axis">
            {ticks.map((tk) => (
              <text key={tk.t} x={x(tk.t)} y={TOP + PLOT_H + 20} textAnchor="middle">{tk.label}</text>
            ))}
          </g>

          {hover !== null && (
            <g>
              <line x1={hx} x2={hx} y1={TOP} y2={TOP + PLOT_H} stroke="var(--ink-3)" strokeDasharray="2 3" />
              <circle cx={hx} cy={y(trend.ram[hover])} r={4} fill="var(--c-ram)" stroke="var(--bg)" strokeWidth={2} />
              <circle cx={hx} cy={y(trend.cpu[hover])} r={4} fill="var(--c-cpu)" stroke="var(--bg)" strokeWidth={2} />
            </g>
          )}

          <rect x={0} y={TOP} width={plotW} height={PLOT_H} fill="transparent"
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}

      {hover !== null && (
        <div className="tip" style={{ left: hx, top: Math.min(y(trend.cpu[hover]), y(trend.ram[hover])) }}>
          <div className="mono">{clock(trend.t[hover], true)}{inBackup(trend.t[hover]) ? " · backup" : ""}</div>
          <div className="tip-row"><span className="sw sw-line" style={{ background: "var(--c-cpu)", width: 10, height: 2, display: "inline-block" }} />CPU {pct(trend.cpu[hover])}</div>
          <div className="tip-row"><span className="sw sw-line" style={{ background: "var(--c-ram)", width: 10, height: 2, display: "inline-block" }} />RAM {pct(trend.ram[hover])}</div>
        </div>
      )}

      {peak && hover === null && width > 0 && (
        <div className="annot" style={{
          left: Math.min(Math.max(90, x(peak.t)), plotW - 90),
          top: Math.max(0, y(peak.cpu) - 58),
        }}>
          <b>↑ pico de {pct(peak.cpu)}</b> <span className="muted">+{peak.delta.toLocaleString("pt-BR")} sobre a média</span>
          <span>{peak.top.length ? peak.top.join(" + ") + " · " : ""}{clock(peak.t, range !== "24h")}</span>
        </div>
      )}
    </div>
  );
}

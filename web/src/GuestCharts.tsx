import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Guest } from "./api";
import { useWidth } from "./charts/useSize";
import { bytes, clock, pct } from "./format";

const RANGES = ["1h", "24h", "7d", "30d"] as const;

interface Series {
  label: string;
  color: string;
  values: number[];
}

const rate = (v: number) => `${bytes(v)}/s`;

/** CPU, memória, rede e disco de um guest ao longo do tempo. */
export function GuestCharts({ g }: { g: Guest }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const { data, error, isLoading } = useQuery({
    queryKey: ["guest-rrd", g.id, range],
    queryFn: () => api.guestRRD(g, range),
    refetchInterval: range === "1h" ? 30_000 : 120_000,
    placeholderData: (p) => p,
  });

  return (
    <div className="gcharts">
      <div className="seg" role="group" aria-label="Período">
        {RANGES.map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && !data.t.length && <p className="muted">Sem dados nesse período (o guest estava desligado?).</p>}
      {data && data.t.length > 0 && (
        <>
          <MiniChart title="CPU" t={data.t} fmt={pct} max={100} long={range !== "1h"}
            series={[{ label: "CPU", color: "var(--c-cpu)", values: data.cpu }]} />
          <MiniChart title="Memória" t={data.t} fmt={bytes} max={data.maxmem || undefined} long={range !== "1h"}
            series={[{ label: "Usada", color: "var(--c-ram)", values: data.mem }]} />
          <MiniChart title="Rede" t={data.t} fmt={rate} long={range !== "1h"}
            series={[{ label: "Entrada", color: "var(--c-cpu)", values: data.netin }, { label: "Saída", color: "var(--c-ram)", values: data.netout }]} />
          <MiniChart title="Disco" t={data.t} fmt={rate} long={range !== "1h"}
            series={[{ label: "Leitura", color: "var(--c-cpu)", values: data.diskread }, { label: "Escrita", color: "var(--c-ram)", values: data.diskwrite }]} />
        </>
      )}
    </div>
  );
}

const H = 92;
const PAD = 6;

export function MiniChart({ title, t, series, fmt, max, long }: {
  title: string; t: number[]; series: Series[]; fmt: (v: number) => string; max?: number; long: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values)) * 1.1;
  const x = (i: number) => (t.length > 1 ? (i / (t.length - 1)) * width : 0);
  const y = (v: number) => PAD + (1 - Math.min(v, top) / top) * (H - PAD * 2);
  const last = series.map((s) => s.values[s.values.length - 1] ?? 0);

  return (
    <div className="mchart">
      <div className="mchart-head">
        <b>{title}</b>
        <div className="legend">
          {series.map((s, i) => (
            <span key={s.label}>
              <i className="sw sw-line" style={{ background: s.color }} />
              {series.length > 1 ? `${s.label} ` : ""}
              <span className="mono">{fmt(hover !== null ? s.values[hover] : last[i])}</span>
            </span>
          ))}
          {hover !== null && <span className="mono muted">{clock(t[hover], long)}</span>}
        </div>
      </div>
      <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          if (!width || t.length < 2) return;
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          setHover(Math.max(0, Math.min(t.length - 1, Math.round((px / width) * (t.length - 1)))));
        }}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`${title}: ${series.map((s, i) => `${s.label} ${fmt(last[i])}`).join(", ")}`}>
            <line x1={0} x2={width} y1={H - PAD} y2={H - PAD} stroke="var(--grid)" />
            <line x1={0} x2={width} y1={PAD} y2={PAD} stroke="var(--grid)" strokeDasharray="2 4" />
            {series.map((s) => (
              <path key={s.label} fill="none" stroke={s.color} strokeWidth={1.75} strokeLinejoin="round"
                d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("")} />
            ))}
            {hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD} y2={H - PAD} stroke="var(--ink-3)" strokeDasharray="2 3" />
                {series.map((s) => <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r={3.5} fill={s.color} stroke="var(--bg)" strokeWidth={2} />)}
              </>
            )}
          </svg>
        )}
      </div>
      <div className="mchart-foot mono muted">
        <span>{clock(t[0], long)}</span>
        <span>máx {fmt(top / (max ? 1 : 1.1))}</span>
        <span>{clock(t[t.length - 1], long)}</span>
      </div>
    </div>
  );
}

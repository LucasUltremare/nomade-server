import type { Guest } from "./api";

const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const nf1fixed = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const pct = (v: number) => `${nf1.format(v)}%`;
export const pctFixed = (v: number) => `${nf1fixed.format(v)}%`;
export const num = (v: number) => nf1.format(v);

const units = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Bytes em base 2 com o rótulo curto que o Proxmox também usa (GB = GiB). */
export function bytes(v: number) {
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf1.format(v)} ${units[i]}`;
}

/** "3,8 / 8 GB": usado e total na unidade do total. */
export function bytesPair(used: number, total: number) {
  let i = 0;
  let t = total;
  while (t >= 1024 && i < units.length - 1) {
    t /= 1024;
    i++;
  }
  const u = used / 1024 ** i;
  return `${nf1.format(u)} / ${nf1.format(t)} ${units[i]}`;
}

export function uptime(sec: number) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const kindLabel = (g: Pick<Guest, "type">) => (g.type === "qemu" ? "VM" : "LXC");

export function clock(ts: number, withDay = false) {
  const d = new Date(ts * 1000);
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (!withDay) return hm;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `hoje ${hm}`;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `ontem ${hm}`;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

/** Limite de CPU (% da alocação) a partir do qual um guest conta como crítico. */
export const HOT = 80;
export const IDLE = 15;

export type Health = "running" | "hot" | "stopped" | "paused";

export function health(g: Guest): Health {
  if (g.status === "paused" || g.status === "suspended") return "paused";
  if (g.status !== "running") return "stopped";
  return g.cpu >= HOT ? "hot" : "running";
}

// Cliente da API do Mia (backend Go em internal/server).

export type GuestType = "qemu" | "lxc";

export interface Guest {
  id: string; // "lxc/103"
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  status: string;
  cpu: number; // % da alocação
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  template: boolean;
  tags: string[];
  lock?: string;
  hastate?: string;
}

export interface NodeSummary {
  name: string;
  online: boolean;
  ip?: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}

export interface Cluster {
  name: string;
  nodes: number;
  nodesOnline: number;
  quorate: boolean;
  standalone: boolean;
  pveVersion: string;
}

export interface GuestSamples {
  id: string;
  name: string;
  t: number[];
  cpu: number[];
  mem: number[];
}

export interface Overview {
  range: Range;
  from: number;
  to: number;
  cluster: Cluster;
  tailscale: "" | "online" | "offline";
  load: { avg: number; now: number; delta: number | null; guestsActive: number };
  samples: GuestSamples[];
  trend: {
    t: number[];
    cpu: number[];
    ram: number[];
    backups: [number, number][];
    peak: { t: number; cpu: number; delta: number; top: string[] } | null;
  };
  guests: Guest[];
  nodes: NodeSummary[];
  warnings: string[];
}

export interface NodeDetail {
  name: string;
  online: boolean;
  ip: string;
  cpu: number;
  threads: number;
  cores: number;
  sockets: number;
  model: string;
  load: string[];
  memUsed: number;
  memTotal: number;
  uptime: number;
  pveVersion: string;
  kernel: string;
  pool: { name: string; kind: "zfs" | "storage"; used: number; total: number } | null;
  guests: Guest[];
}

export interface BackupStorage {
  storage: string;
  type: string;
  shared: boolean;
  avail: number;
  total: number;
  nodes: string[];
}

export type Range = "24h" | "7d" | "30d";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Avisado quando a sessão cai, pra o App voltar pro login.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined || method !== "GET" ? { "Content-Type": "application/json", "X-Mia": "1" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/login")) onUnauthorized();
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  meta: () => request<{ version: string; demo: boolean }>("GET", "/api/meta"),
  realms: () => request<{ realm: string; type: string; comment: string; default?: number }[]>("GET", "/api/realms"),
  login: (username: string, password: string, realm: string) =>
    request<{ user: string; needTfa: boolean }>("POST", "/api/login", { username, password, realm }),
  tfa: (code: string, kind: string) => request<{ user: string }>("POST", "/api/login/tfa", { code, kind }),
  logout: () => request<{ ok: boolean }>("POST", "/api/logout"),
  me: () => request<{ user: string; favorites: string[] | null }>("GET", "/api/me"),
  status: () =>
    request<{ cluster: Cluster; tailscale: Overview["tailscale"]; nodes: NodeSummary[] }>("GET", "/api/status"),
  overview: (range: Range) => request<Overview>("GET", `/api/overview?range=${range}`),
  guests: () => request<Guest[]>("GET", "/api/guests"),
  node: (name: string) => request<NodeDetail>("GET", `/api/nodes/${encodeURIComponent(name)}`),
  guestAction: (g: Pick<Guest, "type" | "vmid">, action: string) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/${action}`),
  setFavorites: (ids: string[]) => request<{ favorites: string[] }>("PUT", "/api/favorites", { ids }),
  backupStorages: () => request<{ storages: BackupStorage[]; nodes: string[] }>("GET", "/api/backup/storages"),
  backup: (storage: string, mode: string) =>
    request<{ tasks: { node: string; upid?: string; error?: string }[] }>("POST", "/api/backup", { storage, mode }),
};

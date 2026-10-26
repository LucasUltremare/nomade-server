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

export interface App {
  slug: string;
  name: string;
  description: string;
  logo: string;
  type: "lxc" | "vm" | "pve" | "addon" | "turnkey";
  script: string;
  scriptUrl: string;
  port: number;
  website: string;
  docs: string;
  categories: string[];
  executeIn: string[];
  cpu: number;
  ram: number;
  disk: number;
  os: string;
  osVersion: string;
  privileged: boolean;
  updateable: boolean;
  arm: boolean;
  defaultUser?: string;
  defaultPass?: string;
  notes: { text: string; type: string }[];
  updated: string;
}

export interface AppCatalog {
  apps: App[];
  categories: { name: string; icon: string; order: number }[];
  fetchedAt: string;
}

export interface ConsoleTicket {
  node: string;
  kind: "node" | "lxc" | "qemu";
  vmid: number;
  port: number;
  ticket: string;
  user: string;
}

export interface TaskState {
  status: "running" | "stopped";
  exitstatus: string;
  lines: { n: number; t: string }[];
}

export interface LxcOptions {
  nextid: number;
  templates: { volid: string; name: string; size: number }[];
  available: { template: string; os: string; version: string; headline: string }[];
  rootfs: { storage: string; type: string; avail: number; total: number }[];
  templateStorages: { storage: string; type: string; avail: number; total: number }[];
  bridges: { iface: string; cidr: string; comments: string }[];
}

export interface LxcRequest {
  vmid: number;
  hostname: string;
  template: string;
  cores: number;
  memory: number;
  swap: number;
  disk: number;
  storage: string;
  bridge: string;
  ip: string;
  gateway: string;
  vlan: number;
  password: string;
  sshKeys: string;
  unprivileged: boolean;
  nesting: boolean;
  tun: boolean;
  start: boolean;
  onboot: boolean;
  tags: string;
}

export interface NetIface {
  iface: string;
  type: string;
  active: boolean;
  autostart: boolean;
  method: string;
  cidr: string;
  gateway: string;
  cidr6: string;
  ports: string;
  vlanAware: boolean;
  vlanId: string;
  vlanRaw: string;
  comments: string;
  pending: boolean;
}

export interface StorageRow {
  node: string;
  storage: string;
  type: string;
  content: string[];
  used: number;
  total: number;
  avail: number;
  shared: boolean;
  active: boolean;
}

export interface Volume {
  volid: string;
  name: string;
  content: string;
  subtype: string;
  format: string;
  size: number;
  ctime: number;
  vmid: number;
  notes: string;
  protected: boolean;
}

export interface Settings {
  root: boolean;
  tailscale: { configured: boolean; hint: string };
}

export interface Disk {
  key: string;
  volume: string;
  storage: string;
  size: number;
  mountpoint?: string;
  backup: boolean;
  bind: boolean;
  unused: boolean;
}

export interface GuestConfig {
  node: string;
  kind: GuestType;
  vmid: number;
  status: string;
  cores: number;
  memory: number;
  swap: number;
  disks: Disk[];
  storages: { storage: string; type: string; avail: number; total: number }[];
  pending: string[];
  hasCd: boolean;
  cdrom: string;
}

export interface HealthCheck {
  level: "crit" | "warn" | "ok";
  area: string;
  title: string;
  detail?: string;
  node?: string;
}

export interface HealthReport {
  checks: HealthCheck[];
  disks: { node: string; dev: string; model: string; type: string; size: number; health: string; wearout: number; used: string }[];
  services: { node: string; name: string; state: string; desc: string }[];
  updates: { node: string; count: number; packages: string[] }[];
  certs: { node: string; file: string; subject: string; notAfter: number }[];
  at: number;
}

export interface Retention {
  last: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface BackupJob {
  id: string;
  enabled: boolean;
  schedule: string;
  storage: string;
  mode: string;
  compress: string;
  all: boolean;
  vmids: number[];
  exclude: number[];
  node: string;
  retention: Retention;
  comment: string;
  nextRun: number;
}

export interface GuestBackup {
  vmid: number;
  name: string;
  type: GuestType;
  node: string;
  last: number;
  storage: string;
  size: number;
  count: number;
  covered: boolean;
}

export interface TaskRow {
  upid: string;
  node: string;
  type: string;
  id: string;
  user: string;
  status: string;
  starttime: number;
  endtime: number;
}

export interface FwRule {
  pos: number;
  type: "in" | "out" | "group";
  action: string;
  macro: string;
  proto: string;
  dport: string;
  sport: string;
  source: string;
  dest: string;
  iface: string;
  comment: string;
  enable: boolean;
}

export interface Firewall {
  enable: boolean;
  policyIn: string;
  policyOut: string;
  rules: FwRule[];
  miaPort?: number;
  miaPortOpen?: boolean;
}

export type FwScope = { scope: "cluster" } | { scope: "node"; node: string } | { scope: "guest"; kind: GuestType; vmid: number };

const fwQuery = (s: FwScope) => new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])).toString();

export interface Snapshot {
  name: string;
  description: string;
  time: number;
  parent: string;
  ram: boolean;
  current: boolean;
}

export interface GuestRRD {
  t: number[];
  cpu: number[];
  mem: number[];
  maxmem: number;
  netin: number[];
  netout: number[];
  diskread: number[];
  diskwrite: number[];
}

export interface VmOptions {
  nextid: number;
  isos: { volid: string; name: string; size: number }[];
  disks: { storage: string; type: string; avail: number; total: number }[];
  bridges: { iface: string; cidr: string; comments: string }[];
}

export interface VmRequest {
  vmid: number;
  name: string;
  os: "linux" | "win11" | "win10" | "other";
  iso: string;
  cores: number;
  memory: number;
  disk: number;
  storage: string;
  bridge: string;
  vlan: number;
  start: boolean;
  onboot: boolean;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  available: boolean;
  selfUpdate: boolean;
}

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

  task: (upid: string, start: number) => request<TaskState>("GET", `/api/tasks/${encodeURIComponent(upid)}?start=${start}`),
  console: (node: string, kind: "node" | "lxc" | "qemu", vmid = 0) =>
    request<ConsoleTicket>("POST", "/api/console", { node, kind, vmid }),
  apps: (refresh = false) => request<AppCatalog>("GET", `/api/apps${refresh ? "?refresh=1" : ""}`),

  lxcOptions: (node: string) => request<LxcOptions>("GET", `/api/nodes/${enc(node)}/lxc-options`),
  downloadTemplate: (node: string, storage: string, template: string) =>
    request<{ upid: string }>("POST", `/api/nodes/${enc(node)}/templates`, { storage, template }),
  createLxc: (node: string, body: LxcRequest) =>
    request<{ upid: string; vmid: number }>("POST", `/api/nodes/${enc(node)}/lxc`, body),

  network: (node: string) =>
    request<{ ifaces: NetIface[]; changes: string; traffic: { in?: number; out?: number } }>("GET", `/api/nodes/${enc(node)}/network`),
  networkCreate: (node: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>("POST", `/api/nodes/${enc(node)}/network`, body),
  networkDelete: (node: string, iface: string) =>
    request<{ ok: boolean }>("DELETE", `/api/nodes/${enc(node)}/network/${enc(iface)}`),
  networkApply: (node: string, op: "apply" | "revert") =>
    request<{ upid: string }>("POST", `/api/nodes/${enc(node)}/network/${op}`),

  storages: () => request<{ storages: StorageRow[]; nodes: string[] }>("GET", "/api/storage"),
  storageContent: (node: string, storage: string) =>
    request<Volume[]>("GET", `/api/storage/${enc(node)}/${enc(storage)}/content`),
  deleteVolume: (node: string, storage: string, volid: string) =>
    request<{ upid: string }>("DELETE", `/api/storage/${enc(node)}/${enc(storage)}/content?volid=${enc(volid)}`),
  downloadURL: (node: string, storage: string, body: { url: string; filename: string; content: string }) =>
    request<{ upid: string }>("POST", `/api/storage/${enc(node)}/${enc(storage)}/download-url`, body),
  restore: (node: string, body: { volid: string; kind: "lxc" | "qemu"; storage: string; start: boolean }) =>
    request<{ upid: string; vmid: number }>("POST", `/api/nodes/${enc(node)}/restore`, body),

  guestConfig: (g: Pick<Guest, "type" | "vmid">) => request<GuestConfig>("GET", `/api/guests/${g.type}/${g.vmid}/config`),
  guestResources: (g: Pick<Guest, "type" | "vmid">, body: { cores: number; memory: number; swap: number }) =>
    request<{ upid: string }>("PUT", `/api/guests/${g.type}/${g.vmid}/resources`, body),
  diskResize: (g: Pick<Guest, "type" | "vmid">, disk: string, add: number) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/disks/resize`, { disk, add }),
  diskAdd: (g: Pick<Guest, "type" | "vmid">, body: { storage: string; size: number; path: string; backup: boolean }) =>
    request<{ upid: string; key: string }>("POST", `/api/guests/${g.type}/${g.vmid}/disks/add`, body),
  diskMove: (g: Pick<Guest, "type" | "vmid">, disk: string, storage: string) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/disks/move`, { disk, storage }),
  diskRemove: (g: Pick<Guest, "type" | "vmid">, disk: string) =>
    request<{ upid: string }>("DELETE", `/api/guests/${g.type}/${g.vmid}/disks/${disk}`),
  migrate: (g: Pick<Guest, "type" | "vmid">, target: string) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/migrate`, { target }),

  snapshots: (g: Pick<Guest, "type" | "vmid">) => request<Snapshot[]>("GET", `/api/guests/${g.type}/${g.vmid}/snapshots`),
  snapshotCreate: (g: Pick<Guest, "type" | "vmid">, body: { name: string; description: string; ram: boolean }) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/snapshots`, body),
  snapshotRollback: (g: Pick<Guest, "type" | "vmid">, name: string) =>
    request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/snapshots/${enc(name)}/rollback`),
  snapshotDelete: (g: Pick<Guest, "type" | "vmid">, name: string) =>
    request<{ upid: string }>("DELETE", `/api/guests/${g.type}/${g.vmid}/snapshots/${enc(name)}`),
  guestRRD: (g: Pick<Guest, "type" | "vmid">, range: string) =>
    request<GuestRRD>("GET", `/api/guests/${g.type}/${g.vmid}/rrd?range=${range}`),
  vmOptions: (node: string) => request<VmOptions>("GET", `/api/nodes/${enc(node)}/vm-options`),
  createVm: (node: string, body: VmRequest) => request<{ upid: string; vmid: number }>("POST", `/api/nodes/${enc(node)}/qemu`, body),
  setCdrom: (g: Pick<Guest, "type" | "vmid">, iso: string) =>
    request<{ upid: string }>("PUT", `/api/guests/${g.type}/${g.vmid}/cdrom`, { iso }),
  clone: (g: Pick<Guest, "type" | "vmid">, body: { name: string; full: boolean; target: string; storage: string }) =>
    request<{ upid: string; vmid: number }>("POST", `/api/guests/${g.type}/${g.vmid}/clone`, body),
  makeTemplate: (g: Pick<Guest, "type" | "vmid">) => request<{ upid: string }>("POST", `/api/guests/${g.type}/${g.vmid}/template`),
  destroy: (g: Pick<Guest, "type" | "vmid">, confirm: string) =>
    request<{ upid: string }>("DELETE", `/api/guests/${g.type}/${g.vmid}`, { confirm }),

  health: () => request<HealthReport>("GET", "/api/health"),
  aptRefresh: (node: string) => request<{ upid: string }>("POST", `/api/nodes/${enc(node)}/apt/refresh`),

  jobs: () => request<BackupJob[]>("GET", "/api/backup/jobs"),
  saveJob: (j: Partial<BackupJob>) =>
    request<{ ok: boolean }>(j.id ? "PUT" : "POST", j.id ? `/api/backup/jobs/${enc(j.id)}` : "/api/backup/jobs", j),
  deleteJob: (id: string) => request<{ ok: boolean }>("DELETE", `/api/backup/jobs/${enc(id)}`),
  runJob: (id: string) =>
    request<{ tasks: { node: string; upid?: string; error?: string }[] }>("POST", `/api/backup/jobs/${enc(id)}/run`),
  backupStatus: () => request<GuestBackup[]>("GET", "/api/backup/status"),

  tasks: () => request<TaskRow[]>("GET", "/api/tasks"),
  stopTask: (upid: string) => request<{ ok: boolean }>("DELETE", `/api/tasks/${enc(upid)}`),

  firewall: (s: FwScope) => request<Firewall>("GET", `/api/firewall?${fwQuery(s)}`),
  firewallOptions: (s: FwScope, body: { enable?: boolean; policyIn?: string; policyOut?: string }) =>
    request<{ ok: boolean }>("PUT", `/api/firewall/options?${fwQuery(s)}`, body),
  firewallAdd: (s: FwScope, rule: Partial<FwRule>) => request<{ ok: boolean }>("POST", `/api/firewall/rules?${fwQuery(s)}`, rule),
  firewallToggle: (s: FwScope, pos: number, enable: boolean) =>
    request<{ ok: boolean }>("PUT", `/api/firewall/rules/${pos}?${fwQuery(s)}`, { enable }),
  firewallDelete: (s: FwScope, pos: number) => request<{ ok: boolean }>("DELETE", `/api/firewall/rules/${pos}?${fwQuery(s)}`),
  firewallMacros: () => request<{ macro: string; descr: string }[]>("GET", "/api/firewall/macros"),

  settings: () => request<Settings>("GET", "/api/settings"),
  setTailscaleKey: (authKey: string) => request<Settings>("PUT", "/api/settings/tailscale", { authKey }),
  tailscaleCommand: (body: Record<string, unknown>) => request<{ command: string }>("POST", "/api/tailscale/command", body),
  updateInfo: () => request<UpdateInfo>("GET", "/api/update"),
  runUpdate: () => request<{ ok: boolean }>("POST", "/api/update"),
};

const enc = encodeURIComponent;

/** Upload com progresso (fetch não informa progresso de envio). */
export function uploadFile(node: string, storage: string, content: string, file: File, onProgress: (f: number) => void) {
  return new Promise<{ upid: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/storage/${enc(node)}/${enc(storage)}/upload`);
    xhr.setRequestHeader("X-Mia", "1");
    xhr.setRequestHeader("X-Filename", file.name);
    xhr.setRequestHeader("X-Content", content);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { upid?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* resposta vazia */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ upid: data.upid ?? "" });
      else reject(new ApiError(xhr.status, data.error ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, "falha de rede no upload"));
    xhr.send(file);
  });
}

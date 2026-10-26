import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest } from "./api";
import { HOT, bytes, bytesPair, health, kindLabel, pct, uptime } from "./format";
import { IconExternal, IconNetwork, IconPlay, IconPower, IconRestart, IconStar, IconStop, IconTerminal, IconX } from "./icons";
import { pveURL } from "./NodePanel";
import { navigate } from "./router";
import { useFavorites, useGuests, useSettings, useStatus, useUI } from "./state";

export function Modal({ label, onClose, children, className = "" }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button:not(.close), select")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label} ref={ref}>
        {children}
      </div>
    </div>
  );
}

function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["guests", "overview", "status", "node"]) qc.invalidateQueries({ queryKey: [k] });
  };
}

// ---------- Guest ----------

const ACTIONS: Record<string, { label: string; icon: typeof IconPlay; confirm?: string; danger?: boolean }> = {
  start: { label: "Iniciar", icon: IconPlay },
  resume: { label: "Retomar", icon: IconPlay },
  shutdown: { label: "Desligar", icon: IconPower, confirm: "Confirmar desligamento" },
  reboot: { label: "Reiniciar", icon: IconRestart, confirm: "Confirmar reinício" },
  stop: { label: "Forçar parada", icon: IconStop, confirm: "Confirmar parada forçada", danger: true },
};

function actionsFor(g: Guest) {
  if (g.template) return [];
  if (g.status === "running") return ["shutdown", "reboot", "stop"];
  if (g.status === "paused" || g.status === "suspended") return ["resume", "stop"];
  return ["start"];
}

export function GuestDialog() {
  const ui = useUI();
  const { data: guests } = useGuests();
  const favs = useFavorites(guests);
  const refresh = useRefreshAll();
  const [armed, setArmed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [exposing, setExposing] = useState(false);
  const g = guests?.find((x) => x.id === ui.guestId);

  const run = useMutation({
    mutationFn: (action: string) => api.guestAction(g!, action),
    onSuccess: (_, action) => {
      setDone(`${ACTIONS[action].label}: task enviada ao Proxmox.`);
      setTimeout(refresh, 1500);
    },
  });

  if (!ui.guestId) return null;
  const close = () => {
    ui.openGuest(null);
    setArmed(null);
    setDone(null);
    setExposing(false);
    run.reset();
  };
  if (!g) {
    return (
      <Modal label="Guest" onClose={close}>
        <p className="muted">{guests ? "Guest não encontrado." : "Carregando…"}</p>
      </Modal>
    );
  }

  const isFav = favs.ids.includes(g.id);
  const hot = g.cpu >= HOT;
  return (
    <Modal label={g.name} onClose={close}>
      <button className="close" onClick={close} aria-label="Fechar"><IconX /></button>
      <h2>{g.name}</h2>
      <div className="dialog-sub">
        {kindLabel(g)} {g.vmid} · {g.node} · <span className={`dot ${health(g)}`} style={{ display: "inline-block", verticalAlign: 1 }} /> {g.status}
        {g.template ? " · template" : ""}
      </div>

      {g.status === "running" && (
        <div className="meters">
          <Meter label="CPU" value={`${pct(g.cpu)} de ${g.maxcpu} ${g.maxcpu === 1 ? "núcleo" : "núcleos"}`} frac={g.cpu / 100} hot={hot} />
          <Meter label="Memória" value={bytesPair(g.mem, g.maxmem)} frac={g.mem / g.maxmem} />
          {g.maxdisk > 0 && <Meter label="Disco" value={bytesPair(g.disk, g.maxdisk)} frac={g.disk / g.maxdisk} />}
        </div>
      )}

      <dl className="kv">
        <dt>Uptime</dt><dd>{uptime(g.uptime)}</dd>
        {g.status !== "running" && <><dt>Memória</dt><dd>{bytes(g.maxmem)} · {g.maxcpu} vCPU</dd></>}
        {g.hastate && <><dt>HA</dt><dd>{g.hastate}</dd></>}
        {g.lock && <><dt>Lock</dt><dd>{g.lock}</dd></>}
        {g.tags.length > 0 && <><dt>Tags</dt><dd className="chips">{g.tags.map((t) => <span key={t}>{t}</span>)}</dd></>}
      </dl>

      <div className="dialog-actions">
        {actionsFor(g).map((a) => {
          const A = ACTIONS[a];
          const confirming = armed === a;
          return (
            <button key={a} className={`btn ${A.danger ? "danger" : ""} ${confirming ? "primary" : ""}`}
              disabled={run.isPending}
              onClick={() => {
                if (A.confirm && !confirming) return setArmed(a);
                setArmed(null);
                run.mutate(a);
              }}>
              <A.icon width={15} height={15} /> {confirming ? A.confirm : A.label}
            </button>
          );
        })}
        {g.status === "running" && (g.type === "lxc" ? (
          <button className="btn" onClick={() => {
            close();
            ui.openConsole({ node: g.node, kind: "lxc", vmid: g.vmid, title: g.name });
          }}>
            <IconTerminal width={15} height={15} /> Console
          </button>
        ) : (
          <a className="btn" target="_blank" rel="noreferrer"
            href={pveURL(`?console=kvm&novnc=1&vmid=${g.vmid}&vmname=${encodeURIComponent(g.name)}&node=${encodeURIComponent(g.node)}&resize=scale`)}>
            <IconTerminal width={15} height={15} /> Console ↗
          </a>
        ))}
        {g.type === "lxc" && g.status === "running" && (
          <button className="btn" onClick={() => setExposing((v) => !v)} aria-expanded={exposing}>
            <IconNetwork width={15} height={15} /> Expor no Tailscale
          </button>
        )}
        <button className="btn" onClick={() => favs.toggle(g.id)} aria-pressed={isFav}>
          <IconStar width={15} height={15} fill={isFav ? "currentColor" : "none"} /> {isFav ? "Favorito" : "Favoritar"}
        </button>
        <a className="btn" href={pveURL(`#v1:0:=${g.type}%2F${g.vmid}`)} target="_blank" rel="noreferrer">
          <IconExternal width={15} height={15} /> Abrir no Proxmox
        </a>
      </div>
      {exposing && <ExposeForm g={g} onDone={close} />}
      {run.error && <div className="err">{(run.error as Error).message}</div>}
      {done && !run.error && <div className="ok-msg">{done}</div>}
    </Modal>
  );
}

/** Publica uma porta do CT na tailnet com `tailscale serve`, rodando no console do nó. */
function ExposeForm({ g, onDone }: { g: Guest; onDone: () => void }) {
  const ui = useUI();
  const { data: settings } = useSettings();
  // A porta padrão vem do catálogo de apps, quando o CT tem nome de app conhecido.
  const { data: apps } = useQuery({ queryKey: ["apps"], queryFn: () => api.apps(), staleTime: 30 * 60_000 });
  const guess = apps?.apps.find((a) => a.slug === g.name.toLowerCase())?.port;
  const [touched, setTouched] = useState(false);
  const [manual, setManual] = useState(80);
  const port = touched ? manual : guess ?? manual;
  const setPort = (p: number) => {
    setTouched(true);
    setManual(p);
  };
  const [name, setName] = useState(g.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
  const [err, setErr] = useState("");
  if (!settings?.root) return <div className="warn">Só root@pam pode publicar no Tailscale.</div>;
  if (!settings.tailscale.configured) return <div className="warn">Configure a auth key do Tailscale em Rede → VPN primeiro.</div>;
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api.tailscaleCommand({ action: "expose", vmid: g.vmid, hostname: name, port });
      onDone();
      ui.openConsole({ node: g.node, kind: "node", title: `Tailscale · ${g.name}`, autorun: r.command });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form className="expose" onSubmit={go}>
      <div className="form-grid">
        <label className="field">Nome na tailnet<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
        <label className="field">Porta do app no CT<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(+e.target.value)} /></label>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Instala o Tailscale dentro do CT e publica <span className="mono">https://{name || "nome"}.sua-tailnet.ts.net</span> → porta {port}.
      </p>
      {err && <div className="err">{err}</div>}
      <div className="dialog-actions"><button className="btn primary">Publicar</button></div>
    </form>
  );
}

function Meter({ label, value, frac, hot }: { label: string; value: string; frac: number; hot?: boolean }) {
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><span className="mono">{value}</span></div>
      <div className={`bar ${hot ? "hot" : ""}`}><i style={{ width: `${Math.min(100, frac * 100)}%` }} /></div>
    </div>
  );
}

// ---------- Backup ----------

export function BackupDialog() {
  const ui = useUI();
  const [storage, setStorage] = useState("");
  const [mode, setMode] = useState("snapshot");
  const { data, error, isLoading } = useQuery({
    queryKey: ["backup-storages"],
    queryFn: api.backupStorages,
    enabled: ui.backupOpen,
  });
  const run = useMutation({ mutationFn: () => api.backup(storage, mode) });
  const refresh = useRefreshAll();

  useEffect(() => {
    if (!storage && data?.storages.length) {
      // Prefere um storage compartilhado (PBS/NFS): serve pra todos os nós.
      setStorage((data.storages.find((s) => s.shared) ?? data.storages[0]).storage);
    }
  }, [data, storage]);

  if (!ui.backupOpen) return null;
  const close = () => {
    ui.setBackupOpen(false);
    run.reset();
  };
  const chosen = data?.storages.find((s) => s.storage === storage);
  const missing = chosen ? data!.nodes.filter((n) => !chosen.nodes.includes(n)) : [];

  return (
    <Modal label="Novo backup do cluster" onClose={close}>
      <button className="close" onClick={close} aria-label="Fechar"><IconX /></button>
      <h2>Novo backup do cluster</h2>
      <div className="dialog-sub">vzdump de todos os guests, em cada nó online</div>

      {isLoading && <p className="muted">Buscando storages…</p>}
      {error && <div className="err">{(error as Error).message}</div>}

      {run.data ? (
        <>
          <ul className="kv" style={{ listStyle: "none", padding: 0 }}>
            {run.data.tasks.map((t) => (
              <li key={t.node} style={{ display: "contents" }}>
                <dt>{t.node}</dt>
                <dd className={t.error ? "err" : ""} style={{ margin: 0 }}>{t.error ?? "backup iniciado"}</dd>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => { close(); refresh(); }}>Fechar</button>
          </div>
        </>
      ) : data && (
        <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <label className="field">
            Storage de destino
            <select value={storage} onChange={(e) => setStorage(e.target.value)}>
              {data.storages.map((s) => (
                <option key={s.storage} value={s.storage}>
                  {s.storage} · {s.type}{s.shared ? " · compartilhado" : ""} · {bytes(s.avail)} livres
                </option>
              ))}
            </select>
          </label>
          {!data.storages.length && <div className="err">Nenhum storage com conteúdo "backup" ativo.</div>}
          {missing.length > 0 && <div className="err">Não existe em {missing.join(", ")}: esses nós vão falhar.</div>}

          <div className="field">
            Modo
            <div className="radio-row">
              {[
                ["snapshot", "Snapshot", "sem parar os guests"],
                ["suspend", "Suspender", "pausa durante a cópia"],
                ["stop", "Parar", "mais consistente, com downtime"],
              ].map(([v, l, d]) => (
                <label key={v}>
                  <input type="radio" name="mode" value={v} checked={mode === v} onChange={() => setMode(v)} />
                  {l}<small>{d}</small>
                </label>
              ))}
            </div>
          </div>

          {run.error && <div className="err">{(run.error as Error).message}</div>}
          <div className="dialog-actions">
            <button className="btn primary" type="submit" disabled={!storage || run.isPending}>
              {run.isPending ? "Enviando…" : "Iniciar backup"}
            </button>
            <button className="btn" type="button" onClick={close}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------- Busca ----------

interface Hit {
  key: string;
  name: string;
  meta: string;
  dot: string;
  go: () => void;
}

export function SearchPalette() {
  const ui = useUI();
  const { data: guests } = useGuests();
  const { data: status } = useStatus();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const hits = useMemo<Hit[]>(() => {
    const term = q.trim().toLowerCase();
    const all: Hit[] = [
      ...(status?.nodes ?? []).map((n) => ({
        key: `node/${n.name}`, name: n.name, meta: `nó · ${n.ip ?? ""}`, dot: n.online ? "running" : "stopped",
        go: () => { ui.setNode(n.name); navigate("/"); },
      })),
      ...(guests ?? []).map((g) => ({
        key: g.id, name: g.name, meta: `${kindLabel(g)} ${g.vmid} · ${g.node}`, dot: health(g),
        go: () => ui.openGuest(g.id),
      })),
    ];
    if (!term) return all.slice(0, 12);
    return all.filter((h) => `${h.name} ${h.meta} ${h.key}`.toLowerCase().includes(term)).slice(0, 20);
  }, [q, guests, status, ui]);

  if (!ui.searchOpen) return null;
  const close = () => { ui.setSearchOpen(false); setQ(""); setSel(0); };
  const pick = (h: Hit | undefined) => { if (h) { close(); h.go(); } };

  return (
    <Modal label="Buscar" onClose={close} className="palette">
      <input
        value={q}
        placeholder="Buscar VM, LXC, nó…"
        aria-label="Buscar"
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === "Enter") pick(hits[sel]);
        }}
      />
      {hits.length ? (
        <ul role="listbox">
          {hits.map((h, i) => (
            <li key={h.key}>
              <button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(h)}>
                <span className={`dot ${h.dot}`} />
                <span className="name">{h.name}</span>
                <span className="mono muted">{h.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="empty">Nada encontrado.</div>}
    </Modal>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BackupJob } from "./api";
import { Modal } from "./Dialogs";
import { bytes, kindLabel } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useGuests, useUI } from "./state";

const PRESETS = [
  { v: "01:30", label: "Todo dia, 01:30" },
  { v: "sun 03:00", label: "Domingo, 03:00" },
  { v: "mon..fri 02:00", label: "Dias úteis, 02:00" },
  { v: "*/6:00", label: "A cada 6 horas" },
];

/** Traduz os agendamentos mais comuns; o resto aparece cru. */
function describe(s: string) {
  return PRESETS.find((p) => p.v === s)?.label ?? s;
}

function ago(ts: number) {
  if (!ts) return "nunca";
  const h = (Date.now() / 1000 - ts) / 3600;
  if (h < 1) return "agora há pouco";
  if (h < 24) return `há ${Math.round(h)}h`;
  return `há ${Math.round(h / 24)} dias`;
}

export function BackupsPage() {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: jobs, error } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
  const { data: status } = useQuery({ queryKey: ["backup-status"], queryFn: api.backupStatus });
  const [editing, setEditing] = useState<Partial<BackupJob> | null>(null);
  const [runs, setRuns] = useState<{ node: string; upid?: string; error?: string }[]>([]);
  const [confirmDel, setConfirmDel] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["jobs"] });
    qc.invalidateQueries({ queryKey: ["backup-status"] });
    qc.invalidateQueries({ queryKey: ["health"] });
  };
  const toggle = useMutation({ mutationFn: (j: BackupJob) => api.saveJob({ ...j, enabled: !j.enabled }), onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: string) => api.deleteJob(id), onSuccess: () => { setConfirmDel(""); refresh(); } });
  const run = useMutation({ mutationFn: (id: string) => api.runJob(id), onSuccess: (r) => setRuns(r.tasks) });

  const uncovered = (status ?? []).filter((g) => !g.covered);
  const stale = (status ?? []).filter((g) => g.covered && (!g.last || Date.now() / 1000 - g.last > 3 * 86400));

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Backups</h1>
          <span className="tag">{jobs ? `${jobs.length} jobs agendados` : "…"}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small" onClick={() => ui.setBackupOpen(true)}>Backup agora</button>
          <button className="btn small primary" onClick={() => setEditing({ enabled: true, all: true, schedule: "01:30", mode: "snapshot", compress: "zstd", vmids: [], exclude: [], retention: { last: 0, daily: 7, weekly: 4, monthly: 3, yearly: 0 } })}>
            Novo job
          </button>
        </div>
      </div>
      {error && <div className="err">{(error as Error).message}</div>}

      {(uncovered.length > 0 || stale.length > 0) && (
        <div className="warn" style={{ marginTop: 18 }}>
          {uncovered.length > 0 && <div><b>Sem job de backup:</b> {uncovered.map((g) => `${g.name} (${g.vmid})`).join(", ")}</div>}
          {stale.length > 0 && <div><b>Último backup com mais de 3 dias:</b> {stale.map((g) => `${g.name} (${ago(g.last)})`).join(", ")}</div>}
        </div>
      )}

      <div className="job-list">
        {(jobs ?? []).map((j) => (
          <div key={j.id} className={`card job ${j.enabled ? "" : "off"}`}>
            <div className="job-head">
              <label className="switch" title={j.enabled ? "Desligar" : "Ligar"}>
                <input type="checkbox" checked={j.enabled} onChange={() => toggle.mutate(j)} />
                <span />
              </label>
              <div>
                <b>{j.comment || describe(j.schedule)}</b>
                <div className="mono muted">{describe(j.schedule)} · {j.storage} · {j.mode}</div>
              </div>
            </div>
            <div className="job-meta">
              <span>{j.all ? `Todos os guests${j.exclude.length ? `, menos ${j.exclude.join(", ")}` : ""}` : `Guests ${j.vmids.join(", ")}`}</span>
              <span>Guarda: {retentionText(j)}</span>
              {j.enabled && j.nextRun > 0 && <span>Próximo: {new Date(j.nextRun * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>}
            </div>
            <div className="job-actions">
              <button className="btn small" onClick={() => run.mutate(j.id)} disabled={run.isPending}>Rodar agora</button>
              <button className="btn small" onClick={() => setEditing(j)}>Editar</button>
              {confirmDel === j.id
                ? <button className="btn small danger" onClick={() => del.mutate(j.id)}>Confirmar</button>
                : <button className="btn small" onClick={() => setConfirmDel(j.id)}>Apagar</button>}
            </div>
          </div>
        ))}
        {jobs && !jobs.length && <p className="muted">Nenhum job. Crie um pra o Proxmox fazer backup sozinho.</p>}
      </div>
      {(toggle.error || del.error || run.error) && <div className="err">{((toggle.error || del.error || run.error) as Error).message}</div>}
      {runs.map((r) => (
        <div key={r.node} style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>{r.node}</p>
          {r.upid ? <TaskLog upid={r.upid} onDone={refresh} /> : <div className="err">{r.error}</div>}
        </div>
      ))}

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Por guest</h2>
            <p>Último backup encontrado nos storages. Os arquivos e a restauração ficam em Armazenamento.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Guest</th><th>Nó</th><th>Último backup</th><th>Onde</th><th className="num">Tamanho</th><th className="num">Cópias</th><th>Job</th></tr></thead>
            <tbody>
              {(status ?? []).map((g) => {
                const old = !g.last || Date.now() / 1000 - g.last > 3 * 86400;
                return (
                  <tr key={g.vmid} onClick={() => ui.openGuest(`${g.type}/${g.vmid}`)}>
                    <td><span className="mono muted">{kindLabel(g)} {g.vmid}</span> {g.name}</td>
                    <td className="mono">{g.node}</td>
                    <td><span className="status"><span className={`dot ${old ? "hot" : "running"}`} />{ago(g.last)}</span></td>
                    <td className="mono">{g.storage || "—"}</td>
                    <td className="num">{g.size ? bytes(g.size) : "—"}</td>
                    <td className="num">{g.count}</td>
                    <td>{g.covered ? "sim" : <span style={{ color: "var(--hot)" }}>não</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {editing && <JobDialog job={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function retentionText(j: BackupJob) {
  const r = j.retention;
  const parts = [
    r.last && `${r.last} últimos`, r.daily && `${r.daily} diários`, r.weekly && `${r.weekly} semanais`,
    r.monthly && `${r.monthly} mensais`, r.yearly && `${r.yearly} anuais`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "tudo";
}

function JobDialog({ job, onClose, onSaved }: { job: Partial<BackupJob>; onClose: () => void; onSaved: () => void }) {
  const { data: guests } = useGuests();
  const { data: stores } = useQuery({ queryKey: ["backup-storages"], queryFn: api.backupStorages });
  const [j, setJ] = useState<Partial<BackupJob>>(job);
  const [custom, setCustom] = useState(!PRESETS.some((p) => p.v === job.schedule));
  const set = <K extends keyof BackupJob>(k: K, v: BackupJob[K]) => setJ((x) => ({ ...x, [k]: v }));
  const save = useMutation({ mutationFn: () => api.saveJob({ ...j, storage: j.storage || stores?.storages[0]?.storage }), onSuccess: onSaved });
  const list = (guests ?? []).filter((g) => !g.template);
  const ids = new Set(j.all ? j.exclude : j.vmids);
  const toggleID = (id: number) => {
    const next = ids.has(id) ? [...ids].filter((x) => x !== id) : [...ids, id];
    if (j.all) set("exclude", next);
    else set("vmids", next);
  };
  const r = j.retention ?? { last: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0 };
  const setR = (k: keyof typeof r, v: number) => set("retention", { ...r, [k]: v });

  return (
    <Modal label="Job de backup" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{job.id ? "Editar job" : "Novo job de backup"}</h2>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <label className="field span2">Nome<input value={j.comment ?? ""} onChange={(e) => set("comment", e.target.value)} placeholder="ex.: Tudo, toda madrugada" /></label>
          <label className="field">
            Quando
            <select value={custom ? "" : j.schedule} onChange={(e) => { setCustom(!e.target.value); if (e.target.value) set("schedule", e.target.value); }}>
              {PRESETS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
              <option value="">Personalizado…</option>
            </select>
          </label>
          {custom ? (
            <label className="field">Calendário do Proxmox<input value={j.schedule ?? ""} onChange={(e) => set("schedule", e.target.value)} placeholder="sat 04:00" /></label>
          ) : <div />}
          <label className="field">
            Storage
            <select value={j.storage ?? ""} onChange={(e) => set("storage", e.target.value)}>
              {!j.storage && <option value="">Escolha…</option>}
              {(stores?.storages ?? []).map((s) => <option key={s.storage} value={s.storage}>{s.storage}{s.shared ? " · compartilhado" : ""}</option>)}
            </select>
          </label>
          <label className="field">
            Modo
            <select value={j.mode} onChange={(e) => set("mode", e.target.value)}>
              <option value="snapshot">Snapshot (sem parar)</option><option value="suspend">Suspender</option><option value="stop">Parar</option>
            </select>
          </label>
        </div>

        <div className="field">
          Quais guests
          <div className="radio-row">
            <label><input type="radio" checked={!!j.all} onChange={() => setJ((x) => ({ ...x, all: true, vmids: [] }))} />Todos{j.all && <small>marque abaixo os que ficam de fora</small>}</label>
            <label><input type="radio" checked={!j.all} onChange={() => setJ((x) => ({ ...x, all: false, exclude: [] }))} />Só alguns</label>
          </div>
        </div>
        <div className="guest-picks">
          {list.map((g) => (
            <label key={g.id} className={`pick ${ids.has(g.vmid) ? "on" : ""} ${j.all ? "exclude" : ""}`}>
              <input type="checkbox" checked={ids.has(g.vmid)} onChange={() => toggleID(g.vmid)} />
              <span className="mono">{g.vmid}</span> {g.name}
            </label>
          ))}
        </div>

        <div className="field">Quantos guardar</div>
        <div className="ret-grid">
          {([["last", "Últimos"], ["daily", "Diários"], ["weekly", "Semanais"], ["monthly", "Mensais"], ["yearly", "Anuais"]] as const).map(([k, l]) => (
            <label key={k} className="field">{l}<input type="number" min={0} value={r[k]} onChange={(e) => setR(k, +e.target.value)} /></label>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={!!j.enabled} onChange={(e) => set("enabled", e.target.checked)} />Ligado</label>

        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>Salvar</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

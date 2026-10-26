import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest, type TaskRow } from "./api";
import { bytes } from "./format";
import { TaskLog, taskLabel } from "./Tasks";

const when = (ts: number) => new Date(ts * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** Backups deste guest: fazer agora, ver os que existem, restaurar por cima. */
export function GuestBackups({ g }: { g: Guest }) {
  const qc = useQueryClient();
  const { data: list, error, isLoading } = useQuery({ queryKey: ["guest-backups", g.id], queryFn: () => api.guestBackups(g) });
  const { data: stores } = useQuery({ queryKey: ["backup-storages"], queryFn: api.backupStorages });
  const [storage, setStorage] = useState("");
  const [mode, setMode] = useState("snapshot");
  const [notes, setNotes] = useState("");
  const [upid, setUpid] = useState("");
  const [restoring, setRestoring] = useState("");
  const [typed, setTyped] = useState("");
  const target = storage || stores?.storages.find((s) => s.nodes.includes(g.node))?.storage || "";
  const refresh = () => qc.invalidateQueries({ queryKey: ["guest-backups", g.id] });
  const now = useMutation({ mutationFn: () => api.guestBackupNow(g, { storage: target, mode, notes }), onSuccess: (r) => setUpid(r.upid) });
  const restore = useMutation({
    mutationFn: () => api.guestRestoreOver(g, restoring, typed),
    onSuccess: (r) => { setUpid(r.upid); setRestoring(""); setTyped(""); },
  });

  return (
    <div className="gbk">
      <form className="hw-res" onSubmit={(e) => { e.preventDefault(); now.mutate(); }}>
        <label className="field">Storage
          <select value={target} onChange={(e) => setStorage(e.target.value)}>
            {(stores?.storages ?? []).filter((s) => s.nodes.includes(g.node)).map((s) => <option key={s.storage}>{s.storage}</option>)}
          </select>
        </label>
        <label className="field">Modo
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="snapshot">Snapshot</option><option value="suspend">Suspender</option><option value="stop">Parar</option>
          </select>
        </label>
        <label className="field">Nota<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opcional" /></label>
        <button className="btn small primary" disabled={!target || now.isPending}>Backup agora</button>
      </form>
      {now.error && <div className="err">{(now.error as Error).message}</div>}
      {upid && <TaskLog key={upid} upid={upid} onDone={refresh} />}

      <div className="hw-title">Backups existentes</div>
      {isLoading && <p className="muted">Procurando nos storages…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      <div className="disk-list">
        {(list ?? []).map((b) => (
          <div key={b.volid} className="disk">
            <div className="disk-main">
              <div><b>{when(b.ctime)}</b><span className="mono muted"> · {b.storage}</span></div>
              <div className="mono muted disk-vol">{b.notes || b.volid}</div>
            </div>
            <div className="disk-size mono">{bytes(b.size)}</div>
            <div className="disk-actions">
              <button className="btn small" onClick={() => { setRestoring(restoring === b.volid ? "" : b.volid); setTyped(""); }}>Restaurar por cima</button>
            </div>
            {restoring === b.volid && (
              <form className="disk-form" onSubmit={(e) => { e.preventDefault(); restore.mutate(); }}>
                <span>Substitui o {g.name} atual por esse backup (desligue antes). Digite <b className="mono">{g.name}</b>:</span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 140 }} aria-label="Confirmar nome" />
                <button className="btn small danger" disabled={typed !== g.name || restore.isPending}>Restaurar</button>
              </form>
            )}
          </div>
        ))}
        {list && !list.length && <p className="muted" style={{ fontSize: 13 }}>Nenhum backup desse guest.</p>}
      </div>
      {restore.error && <div className="err">{(restore.error as Error).message}</div>}
      <p className="muted" style={{ fontSize: 12 }}>Pra restaurar como um guest novo, use Armazenamento.</p>
    </div>
  );
}

/** Histórico de tarefas deste guest. */
export function GuestTasks({ g }: { g: Guest }) {
  const { data, error, isLoading } = useQuery({ queryKey: ["guest-tasks", g.id], queryFn: () => api.guestTasks(g), refetchInterval: 10_000 });
  const [open, setOpen] = useState<TaskRow | null>(null);
  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  return (
    <div>
      <div className="table-wrap" style={{ marginTop: 6 }}>
        <table>
          <thead><tr><th>Início</th><th>Tarefa</th><th>Usuário</th><th>Status</th></tr></thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.upid} onClick={() => setOpen(open?.upid === t.upid ? null : t)}>
                <td className="mono">{when(t.starttime)}</td>
                <td>{taskLabel(t.type)}</td>
                <td className="mono muted">{t.user}</td>
                <td><span className="status"><span className={`dot ${!t.endtime ? "paused" : t.status === "OK" ? "running" : "hot"}`} />{!t.endtime ? "rodando" : t.status}</span></td>
              </tr>
            ))}
            {data && !data.length && <tr><td colSpan={4} className="muted">Nada ainda.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <TaskLog key={open.upid} upid={open.upid} />}
    </div>
  );
}

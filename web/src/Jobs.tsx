import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { dt } from "./Crud";
import { Modal } from "./Dialogs";
import { IconX } from "./icons";
import { useGuests, useSettings } from "./state";

interface JobResult { at: number; ok: boolean; message: string; duration: number }
interface Job {
  id?: string;
  kind: "power" | "snapshot" | "restoretest";
  name: string;
  enabled: boolean;
  time: string;
  days: number[];
  everyHours: number;
  targets: string[];
  action: string;
  keep: number;
  storage: string;
  lastRun?: number;
  history?: JobResult[];
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Mia": "1" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const KIND_LABEL = { power: "Ligar/desligar", snapshot: "Snapshot automático", restoretest: "Teste de restauração" };

function describe(j: Job) {
  const when = j.kind === "snapshot" ? `a cada ${j.everyHours}h, guarda ${j.keep}` : `${j.time}${j.days.length ? ` · ${j.days.map((d) => DAYS[d]).join(", ")}` : " · todo dia"}`;
  const what = j.kind === "power" ? { start: "liga", shutdown: "desliga", reboot: "reinicia" }[j.action] : j.kind === "restoretest" ? `restaura em ${j.storage}` : "snapshot";
  return `${what} · ${when}`;
}

/** Agendamentos da Mia: rodam com o token da Mia, mesmo sem ninguém logado. */
export function Jobs() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data, error } = useQuery({ queryKey: ["jobs-mia"], queryFn: () => req<{ jobs: Job[]; token: boolean; timeZone: string }>("GET", "/api/jobs"), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<Job | null>(null);
  const [confirm, setConfirm] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["jobs-mia"] });
  const run = useMutation({ mutationFn: (id: string) => req("POST", `/api/jobs/${id}/run`), onSuccess: () => setTimeout(refresh, 1500) });
  const del = useMutation({ mutationFn: (id: string) => req("DELETE", `/api/jobs/${id}`), onSuccess: () => { setConfirm(""); refresh(); } });
  const toggle = useMutation({ mutationFn: (j: Job) => req("POST", "/api/jobs", { ...j, enabled: !j.enabled }), onSuccess: refresh });
  const root = settings?.root;
  const blank = (kind: Job["kind"]): Job => ({
    kind, name: "", enabled: true, time: kind === "restoretest" ? "04:00" : "23:00", days: kind === "restoretest" ? [0] : [],
    everyHours: 6, targets: [], action: "shutdown", keep: 4, storage: "",
  });

  return (
    <section className="crud">
      <div className="section-head">
        <div><h2>Agendamentos da Mia</h2><p>Coisas que a Mia faz sozinha no horário: ligar e desligar guests, snapshots automáticos e testar se os backups restauram de verdade.</p></div>
        {root && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn small" onClick={() => setEditing(blank("power"))}>+ Ligar/desligar</button>
            <button className="btn small" onClick={() => setEditing(blank("snapshot"))}>+ Snapshots</button>
            <button className="btn small primary" onClick={() => setEditing(blank("restoretest"))}>+ Teste de restauração</button>
          </div>
        )}
      </div>
      {data && !data.token && (
        <div className="warn">A Mia ainda não tem o token de API pros agendamentos. Rode o comando de instalação de novo (Atualizar) que ele é criado.</div>
      )}
      {!root && <p className="muted">Só root@pam mexe nos agendamentos.</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      <div className="job-list">
        {(data?.jobs ?? []).map((j) => {
          const last = j.history?.[0];
          return (
            <div key={j.id} className={`card job ${j.enabled ? "" : "off"}`}>
              <div className="job-head">
                <label className="switch"><input type="checkbox" checked={j.enabled} disabled={!root} onChange={() => toggle.mutate(j)} /><span /></label>
                <div>
                  <b>{j.name || KIND_LABEL[j.kind]}</b>
                  <div className="mono muted">{KIND_LABEL[j.kind]} · {describe(j)}</div>
                </div>
              </div>
              <div className="job-meta">
                <span>{j.targets.join(", ")}</span>
                {last ? (
                  <span style={{ color: last.ok ? "var(--ok)" : "var(--hot)" }}>{last.ok ? "✓" : "✗"} {dt(last.at)} · {last.message}</span>
                ) : <span className="muted">ainda não rodou</span>}
              </div>
              {root && (
                <div className="job-actions">
                  <button className="btn small" onClick={() => run.mutate(j.id!)}>Rodar agora</button>
                  <button className="btn small" onClick={() => setEditing(j)}>Editar</button>
                  {confirm === j.id
                    ? <button className="btn small danger" onClick={() => del.mutate(j.id!)}>Confirmar</button>
                    : <button className="btn small" onClick={() => setConfirm(j.id!)}>Apagar</button>}
                </div>
              )}
            </div>
          );
        })}
        {data && !data.jobs.length && <p className="muted">Nenhum agendamento ainda.</p>}
      </div>
      {editing && <JobForm job={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </section>
  );
}

function JobForm({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const { data: guests } = useGuests();
  const { data: stores } = useQuery({ queryKey: ["lxc-options-any"], queryFn: () => req<{ storages: { node: string; storage: string; content: string[] }[] }>("GET", "/api/storage") });
  const [j, setJ] = useState<Job>(job);
  const set = <K extends keyof Job>(k: K, v: Job[K]) => setJ((x) => ({ ...x, [k]: v }));
  const save = useMutation({ mutationFn: () => req("POST", "/api/jobs", j), onSuccess: onSaved });
  const list = (guests ?? []).filter((g) => !g.template);
  const rootStores = Array.from(new Set((stores?.storages ?? []).filter((s) => s.content.includes("rootdir") || s.content.includes("images")).map((s) => s.storage)));
  return (
    <Modal label="Agendamento" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{KIND_LABEL[j.kind]}</h2>
      {j.kind === "restoretest" && (
        <p className="muted" style={{ fontSize: 13 }}>
          Em cada execução, pega o último backup de um dos guests (um por vez, em rodízio), restaura num ID novo <b>sem rede</b>,
          liga, confere se ficou de pé por 20 segundos e apaga. O original não é tocado.
        </p>
      )}
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <label className="field span2">Nome<input value={j.name} onChange={(e) => set("name", e.target.value)} placeholder="ex.: desligar o lab de noite" /></label>
          {j.kind === "power" && (
            <label className="field">Ação
              <select value={j.action} onChange={(e) => set("action", e.target.value)}>
                <option value="start">Ligar</option><option value="shutdown">Desligar</option><option value="reboot">Reiniciar</option>
              </select>
            </label>
          )}
          {j.kind === "snapshot" ? (
            <>
              <label className="field">A cada (horas)<input type="number" min={1} value={j.everyHours} onChange={(e) => set("everyHours", +e.target.value)} /></label>
              <label className="field">Guardar os últimos<input type="number" min={1} max={100} value={j.keep} onChange={(e) => set("keep", +e.target.value)} /></label>
            </>
          ) : (
            <label className="field">Horário<input type="time" value={j.time} onChange={(e) => set("time", e.target.value)} /></label>
          )}
          {j.kind === "restoretest" && (
            <label className="field">Restaurar em
              <select value={j.storage} onChange={(e) => set("storage", e.target.value)}>
                <option value="">Escolha…</option>
                {rootStores.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
          )}
        </div>
        {j.kind !== "snapshot" && (
          <div className="field">
            Dias (nenhum = todo dia)
            <div className="chip-picks">
              {DAYS.map((d, i) => (
                <label key={d} className={`pick ${j.days.includes(i) ? "on" : ""}`}>
                  <input type="checkbox" checked={j.days.includes(i)} onChange={() => set("days", j.days.includes(i) ? j.days.filter((x) => x !== i) : [...j.days, i].sort())} />{d}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="field">Guests</div>
        <div className="guest-picks">
          {list.map((g) => (
            <label key={g.id} className={`pick ${j.targets.includes(g.id) ? "on" : ""}`}>
              <input type="checkbox" checked={j.targets.includes(g.id)} onChange={() => set("targets", j.targets.includes(g.id) ? j.targets.filter((x) => x !== g.id) : [...j.targets, g.id])} />
              <span className="mono">{g.vmid}</span> {g.name}
            </label>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={j.enabled} onChange={(e) => set("enabled", e.target.checked)} />Ligado</label>
        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>Salvar</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
      {!!job.history?.length && (
        <>
          <div className="hw-title">Últimas execuções</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Quando</th><th>Resultado</th><th className="num">Duração</th></tr></thead>
              <tbody>{job.history.map((h) => (
                <tr key={h.at} style={{ cursor: "default" }}><td className="mono">{dt(h.at)}</td><td style={{ color: h.ok ? "var(--ok)" : "var(--hot)" }}>{h.message}</td><td className="num">{h.duration}s</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

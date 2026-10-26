import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type TaskRow, type TaskState } from "./api";
import { Modal } from "./Dialogs";
import { IconX } from "./icons";

/** Acompanha uma task do Proxmox (UPID) mostrando o log ao vivo. */
export function TaskLog({ upid, onDone }: { upid: string; onDone?: (ok: boolean, exit: string) => void }) {
  const [lines, setLines] = useState<TaskState["lines"]>([]);
  const [st, setSt] = useState<{ status: string; exit: string }>({ status: "running", exit: "" });
  const [err, setErr] = useState("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop = false;
    let start = 0;
    let timer = 0;
    const tick = async () => {
      try {
        const t = await api.task(upid, start);
        if (stop) return;
        if (t.lines.length) {
          start = t.lines[t.lines.length - 1].n;
          setLines((l) => [...l, ...t.lines]);
        }
        if (t.status === "stopped") {
          setSt({ status: "stopped", exit: t.exitstatus });
          doneRef.current?.(t.exitstatus === "OK", t.exitstatus);
          return;
        }
      } catch (e) {
        if (stop) return;
        setErr((e as Error).message);
      }
      timer = window.setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [upid]);

  useEffect(() => {
    pre.current?.scrollTo({ top: pre.current.scrollHeight });
  }, [lines]);

  const ok = st.status === "stopped" && st.exit === "OK";
  return (
    <div className="tasklog">
      <div className="tasklog-head">
        <span className={`dot ${st.status === "running" ? "paused" : ok ? "running" : "hot"}`} />
        <span>{st.status === "running" ? "Rodando…" : ok ? "Concluído" : `Falhou: ${st.exit}`}</span>
        {err && <span className="err" style={{ margin: 0 }}>{err}</span>}
      </div>
      <pre ref={pre}>{lines.map((l) => l.t).join("\n") || "…"}</pre>
    </div>
  );
}

// ---------- página de tarefas ----------

const TASK_LABEL: Record<string, string> = {
  vzdump: "Backup", vzcreate: "Criar CT", vzrestore: "Restaurar CT", qmrestore: "Restaurar VM", qmcreate: "Criar VM",
  vzstart: "Ligar CT", vzstop: "Parar CT", vzshutdown: "Desligar CT", vzreboot: "Reiniciar CT",
  qmstart: "Ligar VM", qmstop: "Parar VM", qmshutdown: "Desligar VM", qmreboot: "Reiniciar VM",
  vzmigrate: "Migrar CT", qmigrate: "Migrar VM", move_volume: "Mover disco", qmmove: "Mover disco", resize: "Aumentar disco",
  download: "Download", imgcopy: "Upload", imgdel: "Apagar volume", aptupdate: "apt update", srvreload: "Recarregar rede",
  vncshell: "Shell", vncproxy: "Console", termproxy: "Console", vzdestroy: "Apagar CT", qmdestroy: "Apagar VM",
};

export const taskLabel = (t: string) => TASK_LABEL[t] ?? t;

function dur(t: TaskRow) {
  const end = t.endtime || Date.now() / 1000;
  const s = Math.max(0, Math.round(end - t.starttime));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });

export function TasksPage() {
  const { data, error, isLoading } = useTasks();
  const [filter, setFilter] = useState<"all" | "running" | "errors">("all");
  const [open, setOpen] = useState<TaskRow | null>(null);
  const stop = useMutation({ mutationFn: (upid: string) => api.stopTask(upid) });
  const rows = (data ?? []).filter((t) =>
    filter === "running" ? !t.endtime : filter === "errors" ? t.endtime && t.status !== "OK" : true);
  const running = (data ?? []).filter((t) => !t.endtime).length;
  const errors = (data ?? []).filter((t) => t.endtime && t.status !== "OK").length;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Tarefas</h1>
          <span className="tag">o que rodou e está rodando no cluster</span>
        </div>
        <div className="seg" role="group" aria-label="Filtro">
          <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Todas</button>
          <button aria-pressed={filter === "running"} onClick={() => setFilter("running")}>Rodando {running > 0 && <span className="muted">{running}</span>}</button>
          <button aria-pressed={filter === "errors"} onClick={() => setFilter("errors")}>Com erro {errors > 0 && <span className="muted">{errors}</span>}</button>
        </div>
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Início</th><th>Tarefa</th><th>Alvo</th><th>Nó</th><th>Usuário</th><th className="num">Duração</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((t) => {
              const ok = t.status === "OK";
              return (
                <tr key={t.upid} onClick={() => setOpen(t)}>
                  <td className="mono">{new Date(t.starttime * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{taskLabel(t.type)}</td>
                  <td className="mono">{t.id || "—"}</td>
                  <td className="mono">{t.node}</td>
                  <td className="mono muted">{t.user}</td>
                  <td className="num">{dur(t)}</td>
                  <td>
                    <span className="status">
                      <span className={`dot ${!t.endtime ? "paused" : ok ? "running" : "hot"}`} />
                      {!t.endtime ? "rodando" : ok ? "OK" : t.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {!t.endtime && (
                      <button className="btn small danger" onClick={(e) => { e.stopPropagation(); stop.mutate(t.upid); }}>Parar</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {data && !rows.length && <tr><td colSpan={8} className="muted">Nada aqui.</td></tr>}
          </tbody>
        </table>
      </div>
      {stop.error && <div className="err">{(stop.error as Error).message}</div>}
      {open && (
        <Modal label="Tarefa" onClose={() => setOpen(null)} className="wide">
          <button className="close" onClick={() => setOpen(null)} aria-label="Fechar"><IconX /></button>
          <h2>{taskLabel(open.type)}{open.id ? ` · ${open.id}` : ""}</h2>
          <div className="dialog-sub">{open.node} · {open.user} · {new Date(open.starttime * 1000).toLocaleString("pt-BR")}</div>
          <TaskLog upid={open.upid} />
        </Modal>
      )}
    </div>
  );
}

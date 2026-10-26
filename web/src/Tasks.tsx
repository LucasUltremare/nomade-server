import { useEffect, useRef, useState } from "react";
import { api, type TaskState } from "./api";

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

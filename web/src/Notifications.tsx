import { useEffect, useRef, useState } from "react";
import { useHealth } from "./Health";
import { IconBell } from "./icons";
import { taskLabel, useTasks } from "./Tasks";

/** Sininho: problemas de saúde e tarefas que falharam nas últimas 24h. */
export function Notifications({ onOpen }: { onOpen: (tab: "Saúde" | "Tarefas") => void }) {
  const { data: health } = useHealth();
  const { data: tasks } = useTasks();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const issues = (health?.checks ?? []).filter((c) => c.level !== "ok");
  const dayAgo = Date.now() / 1000 - 86400;
  const failed = (tasks ?? []).filter((t) => t.endtime && t.status !== "OK" && t.starttime > dayAgo);
  const count = issues.length + failed.length;
  const crit = issues.some((c) => c.level === "crit") || failed.length > 0;

  return (
    <div className="notif" ref={box}>
      <button className="chip-btn square" aria-label={`Notificações (${count})`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <IconBell width={16} height={16} />
        {count > 0 && <span className={`notif-badge ${crit ? "crit" : ""}`}>{count}</span>}
      </button>
      {open && (
        <div className="notif-pop" role="dialog" aria-label="Notificações">
          {count === 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nada pra ver. Tudo certo.</p>}
          {failed.map((t) => (
            <button key={t.upid} className="notif-item crit" onClick={() => { setOpen(false); onOpen("Tarefas"); }}>
              <b>{taskLabel(t.type)} falhou{t.id ? ` (${t.id})` : ""}</b>
              <span>{t.node} · {t.status}</span>
            </button>
          ))}
          {issues.map((c, i) => (
            <button key={i} className={`notif-item ${c.level}`} onClick={() => { setOpen(false); onOpen("Saúde"); }}>
              <b>{c.title}</b>
              {c.detail && <span>{c.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

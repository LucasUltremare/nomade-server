import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ConsoleTarget } from "./Terminal";

type Status = "connecting" | "connected" | "closed" | "error";

// Tipagem mínima do RFB do noVNC (o pacote não traz .d.ts).
interface RFBInstance extends EventTarget {
  scaleViewport: boolean;
  resizeSession: boolean;
  background: string;
  focusOnClick: boolean;
  disconnect(): void;
  sendCtrlAltDel(): void;
  focus(): void;
}
type RFBCtor = new (el: HTMLElement, url: string, opts: { credentials: { password: string }; wsProtocols: string[] }) => RFBInstance;

/**
 * Console gráfico da VM: o PVE abre um vncproxy e o noVNC conversa com ele
 * pelo mesmo proxy de websocket do terminal; a senha VNC é o ticket.
 */
export function VncConsole({ target, onStatus }: { target: ConsoleTarget; onStatus?: (s: Status) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFBInstance | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [msg, setMsg] = useState("");
  const [attempt, setAttempt] = useState(0);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  useEffect(() => statusRef.current?.(status), [status]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    setStatus("connecting");
    (async () => {
      try {
        const [{ default: RFB }, t] = await Promise.all([
          import("@novnc/novnc") as Promise<{ default: RFBCtor }>,
          api.console(target.node, "qemu", target.vmid ?? 0),
        ]);
        if (disposed) return;
        const q = new URLSearchParams({ node: t.node, kind: "qemu", vmid: String(t.vmid), port: String(t.port), vncticket: t.ticket });
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const r = new RFB(el, `${proto}//${location.host}/api/console/ws?${q}`, {
          credentials: { password: t.ticket },
          wsProtocols: ["binary"],
        });
        r.scaleViewport = true;
        r.background = "#0e0f11";
        r.focusOnClick = true;
        r.addEventListener("connect", () => { setStatus("connected"); r.focus(); });
        r.addEventListener("disconnect", (e) => {
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          setStatus(clean ? "closed" : "error");
          if (!clean) setMsg("a conexão caiu ou a VM está desligada");
        });
        r.addEventListener("securityfailure", (e) => {
          setStatus("error");
          setMsg((e as CustomEvent<{ reason?: string }>).detail?.reason ?? "o Proxmox recusou o console");
        });
        rfb.current = r;
      } catch (e) {
        if (!disposed) {
          setStatus("error");
          setMsg((e as Error).message);
        }
      }
    })();
    return () => {
      disposed = true;
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [target.node, target.vmid, attempt]);

  return (
    <div className="vnc-wrap">
      <div className="vnc-bar">
        <button className="btn small" onClick={() => rfb.current?.sendCtrlAltDel()} disabled={status !== "connected"}>Ctrl+Alt+Del</button>
        <button className="btn small" onClick={() => box.current?.requestFullscreen?.()}>Tela cheia</button>
        <a className="btn small" target="_blank" rel="noreferrer"
          href={`https://${location.hostname}:8006/?console=kvm&novnc=1&vmid=${target.vmid}&node=${encodeURIComponent(target.node)}&resize=scale`}>
          Abrir no Proxmox ↗
        </a>
      </div>
      <div className="vnc" ref={box} />
      {status !== "connected" && (
        <div className={`term-status ${status}`}>
          {status === "connecting" && "Conectando…"}
          {status === "closed" && "Console encerrado."}
          {status === "error" && `Erro: ${msg}`}
          {status !== "connecting" && <button className="btn small" onClick={() => setAttempt((a) => a + 1)}>Reconectar</button>}
        </div>
      )}
    </div>
  );
}

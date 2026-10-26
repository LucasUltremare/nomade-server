import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";

export interface ConsoleTarget {
  node: string;
  kind: "node" | "lxc" | "qemu";
  vmid?: number;
  title: string;
  /** Comando digitado assim que o shell responder (loja de apps, Tailscale). */
  autorun?: string;
}

type Status = "connecting" | "connected" | "closed" | "error";

const enc = new TextEncoder();

/**
 * Terminal do Proxmox (termproxy) via o proxy de websocket do Mia. Mesmo
 * protocolo do pve-xtermjs: "user:ticket\n", "0:len:dados", "1:cols:rows:", "2".
 */
export function Terminal({ target, onStatus }: { target: ConsoleTarget; onStatus?: (s: Status, msg?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [msg, setMsg] = useState("");
  const [attempt, setAttempt] = useState(0);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let ping = 0;
    const update = (s: Status, m = "") => {
      if (disposed) return;
      setStatus(s);
      setMsg(m);
      statusRef.current?.(s, m);
    };

    const css = getComputedStyle(document.documentElement);
    const term = new XTerm({
      fontFamily: css.getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0e0f11", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a428f" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    requestAnimationFrame(() => !disposed && fit.fit());

    const send = (s: string) => ws?.readyState === WebSocket.OPEN && ws.send(s);
    const sendData = (data: string) => send(`0:${enc.encode(data).length}:${data}`);
    const sendSize = () => send(`1:${term.cols}:${term.rows}:`);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container sem tamanho */
      }
    });
    ro.observe(el);
    term.onResize(sendSize);
    term.onData(sendData);

    update("connecting");
    api
      .console(target.node, target.kind, target.vmid ?? 0)
      .then((t) => {
        if (disposed) return;
        const q = new URLSearchParams({
          node: t.node, kind: t.kind, vmid: String(t.vmid), port: String(t.port), vncticket: t.ticket,
        });
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${proto}//${location.host}/api/console/ws?${q}`, "binary");
        ws.binaryType = "arraybuffer";
        let ready = false;
        ws.onopen = () => ws!.send(`${t.user}:${t.ticket}\n`);
        ws.onmessage = (ev) => {
          const bytes = new Uint8Array(ev.data as ArrayBuffer);
          if (ready) {
            term.write(bytes);
            return;
          }
          if (bytes[0] === 79 && bytes[1] === 75) {
            // "OK"
            ready = true;
            update("connected");
            term.write(bytes.slice(2));
            sendSize();
            term.focus();
            ping = window.setInterval(() => send("2"), 30_000);
            // Só na primeira conexão: reconectar não pode reinstalar nada.
            if (target.autorun && attempt === 0) {
              // Espera o prompt aparecer antes de digitar.
              const cmd = target.autorun.endsWith("\n") ? target.autorun : target.autorun + "\n";
              window.setTimeout(() => sendData(cmd.replace(/\n/g, "\r")), 900);
            }
          } else {
            ws!.close();
            update("error", "o Proxmox recusou o terminal");
          }
        };
        ws.onclose = (ev) => {
          clearInterval(ping);
          if (!ready) update("error", `não conectou (código ${ev.code})`);
          else update("closed");
        };
      })
      .catch((e: Error) => update("error", e.message));

    return () => {
      disposed = true;
      clearInterval(ping);
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [target.node, target.kind, target.vmid, target.autorun, attempt]);

  return (
    <div className="term-wrap">
      <div className="term" ref={box} />
      {status !== "connected" && (
        <div className={`term-status ${status}`}>
          {status === "connecting" && "Conectando…"}
          {status === "closed" && "Sessão encerrada."}
          {status === "error" && `Erro: ${msg}`}
          {status !== "connecting" && (
            <button className="btn small" onClick={() => setAttempt((a) => a + 1)}>Reconectar</button>
          )}
        </div>
      )}
    </div>
  );
}

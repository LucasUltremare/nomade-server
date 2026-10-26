import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { kindLabel, health } from "./format";
import { IconMinimize, IconTerminal, IconX } from "./icons";
import { Terminal, type ConsoleTarget } from "./Terminal";
import { VncConsole } from "./VncConsole";
import { useGuests, useStatus, useUI } from "./state";

/**
 * Consoles abertos de qualquer lugar (loja, guest, painel do nó). Fechar a
 * janela só minimiza: o terminal continua conectado, e o que roda nele
 * (instalação de app, atualização) segue até terminar. A barra embaixo lista
 * as sessões; encerrar de verdade é ação separada.
 */
export function ConsoleModal() {
  const ui = useUI();
  const qc = useQueryClient();
  const active = ui.consoles.find((c) => c.id === ui.activeConsole) ?? null;
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const minimize = () => {
    ui.showConsole(null);
    // O que rodou no console pode ter criado guests.
    for (const k of ["guests", "overview", "status", "node", "myapps"]) qc.invalidateQueries({ queryKey: [k] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc vai pro terminal (vim, nano); minimizar é ⌘/Ctrl+Shift+X.
      if (ui.activeConsole && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x") minimize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Fechar a aba derruba as sessões: avisa se tem alguma conectada.
  const live = ui.consoles.some((c) => c.status === "connected" || c.status === "connecting");
  useEffect(() => {
    if (!live) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  const end = (id: string) => {
    setConfirmEnd(null);
    ui.closeConsole(id);
    for (const k of ["guests", "overview", "status", "node", "myapps"]) qc.invalidateQueries({ queryKey: [k] });
  };

  return (
    <>
      {ui.consoles.map((c) => {
        const t = c.target;
        const shown = c.id === active?.id;
        return (
          <div key={c.id} className="overlay console-overlay" style={shown ? undefined : { display: "none" }}>
            <div className="console-modal" role="dialog" aria-modal="true" aria-label={t.title}>
              <div className="console-head">
                <IconTerminal width={16} height={16} />
                <b>{t.title}</b>
                <span className="mono muted">{t.kind === "node" ? `shell · ${t.node}` : `${t.kind === "qemu" ? "VM" : "CT"} ${t.vmid} · ${t.node}`}</span>
                <span className="console-actions">
                  {confirmEnd === c.id ? (
                    <button className="btn small danger" onClick={() => end(c.id)}>Encerrar mesmo</button>
                  ) : (
                    <button className="btn small" onClick={() => (c.status === "connected" ? setConfirmEnd(c.id) : end(c.id))}>Encerrar sessão</button>
                  )}
                  <button className="close" onClick={minimize} aria-label="Minimizar" title="Minimizar: a sessão continua rodando (⌘⇧X)">
                    <IconMinimize />
                  </button>
                </span>
              </div>
              {confirmEnd === c.id && (
                <div className="console-warn">Encerrar fecha o terminal no Proxmox e interrompe o que estiver rodando nele.</div>
              )}
              {t.kind === "qemu"
                ? <VncConsole target={t} onStatus={(st) => ui.setConsoleStatus(c.id, st)} />
                : <Terminal target={t} onStatus={(st) => ui.setConsoleStatus(c.id, st)} />}
            </div>
          </div>
        );
      })}
      {ui.consoles.length > 0 && !active && (
        <div className="console-dock" role="region" aria-label="Terminais abertos">
          {ui.consoles.map((c) => (
            <div key={c.id} className="dock-item">
              <button className="dock-open" onClick={() => ui.showConsole(c.id)} title="Abrir">
                <span className={`dot ${c.status === "connected" ? "running" : c.status === "connecting" ? "paused" : "stopped"}`} />
                <span className="dock-title">{c.target.title}</span>
                <span className="mono muted">{c.status === "connected" ? "rodando" : c.status === "connecting" ? "conectando" : "encerrado"}</span>
              </button>
              <button className="dock-x" aria-label={`Encerrar ${c.target.title}`} title="Encerrar sessão"
                onClick={() => (c.status === "connected" ? (window.confirm(`Encerrar "${c.target.title}"? O que estiver rodando é interrompido.`) && end(c.id)) : end(c.id))}>
                <IconX width={14} height={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ConsolePage() {
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const nodes = status?.nodes ?? [];
  const [target, setTarget] = useState<ConsoleTarget | null>(null);
  const cur = target ?? (nodes.find((n) => n.online) ? { node: nodes.find((n) => n.online)!.name, kind: "node" as const, title: "" } : null);
  const lxcs = (guests ?? []).filter((g) => g.type === "lxc" && !g.template);
  const vms = (guests ?? []).filter((g) => g.type === "qemu" && !g.template);
  const same = (a: ConsoleTarget | null, b: ConsoleTarget) => a?.node === b.node && a?.kind === b.kind && (a?.vmid ?? 0) === (b.vmid ?? 0);

  return (
    <div className="content console-page">
      <div className="console-side">
        <div className="side-title">Nós</div>
        {nodes.map((n) => {
          const t: ConsoleTarget = { node: n.name, kind: "node", title: n.name };
          return (
            <button key={n.name} className="list-btn" aria-pressed={same(cur, t)} disabled={!n.online} onClick={() => setTarget(t)}>
              <span className={`dot ${n.online ? "running" : "stopped"}`} />
              <span className="name">{n.name}</span>
              <span className="mono muted">shell</span>
            </button>
          );
        })}
        <div className="side-title">Contêineres</div>
        {lxcs.map((g) => {
          const t: ConsoleTarget = { node: g.node, kind: "lxc", vmid: g.vmid, title: g.name };
          return (
            <button key={g.id} className="list-btn" aria-pressed={same(cur, t)} disabled={g.status !== "running"}
              onClick={() => setTarget(t)} title={g.status !== "running" ? "Parado" : undefined}>
              <span className={`dot ${health(g)}`} />
              <span className="name">{g.name}</span>
              <span className="mono muted">{g.vmid}</span>
            </button>
          );
        })}
        {vms.length > 0 && (
          <>
            <div className="side-title">VMs</div>
            {vms.map((g) => {
              const t: ConsoleTarget = { node: g.node, kind: "qemu", vmid: g.vmid, title: g.name };
              return (
                <button key={g.id} className="list-btn" aria-pressed={same(cur, t)} disabled={g.status !== "running"}
                  onClick={() => setTarget(t)} title={g.status !== "running" ? "Desligada" : undefined}>
                  <span className={`dot ${health(g)}`} />
                  <span className="name">{g.name}</span>
                  <span className="mono muted">{kindLabel(g)} {g.vmid}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
      <div className="console-main">
        {cur ? (cur.kind === "qemu"
          ? <VncConsole key={`${cur.node}-qemu-${cur.vmid}`} target={cur} />
          : <Terminal key={`${cur.node}-${cur.kind}-${cur.vmid ?? 0}`} target={cur} />)
          : <p className="muted">Nenhum nó online.</p>}
      </div>
    </div>
  );
}

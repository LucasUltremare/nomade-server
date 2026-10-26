import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { kindLabel, health } from "./format";
import { IconTerminal, IconX } from "./icons";
import { Terminal, type ConsoleTarget } from "./Terminal";
import { useGuests, useStatus, useUI } from "./state";

/** Console em tela cheia, aberto de qualquer lugar (loja, guest, painel do nó). */
export function ConsoleModal() {
  const ui = useUI();
  const qc = useQueryClient();
  const t = ui.consoleTarget;

  useEffect(() => {
    if (!t) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc vai pro terminal (vim, nano); fechar é pelo botão ou ⌘/Ctrl+Shift+X.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x") ui.openConsole(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, ui]);

  if (!t) return null;
  const close = () => {
    ui.openConsole(null);
    // O que rodou no console pode ter criado guests.
    for (const k of ["guests", "overview", "status", "node"]) qc.invalidateQueries({ queryKey: [k] });
  };
  return (
    <div className="overlay console-overlay">
      <div className="console-modal" role="dialog" aria-modal="true" aria-label={t.title}>
        <div className="console-head">
          <IconTerminal width={16} height={16} />
          <b>{t.title}</b>
          <span className="mono muted">{t.kind === "node" ? `shell · ${t.node}` : `CT ${t.vmid} · ${t.node}`}</span>
          <button className="close" onClick={close} aria-label="Fechar console" title="Fechar (⌘⇧X)"><IconX /></button>
        </div>
        <Terminal target={t} />
      </div>
    </div>
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
            <p className="muted" style={{ fontSize: 12, margin: "0 4px 8px" }}>
              O console gráfico das VMs abre no Proxmox por enquanto.
            </p>
            {vms.map((g) => (
              <a key={g.id} className="list-btn" target="_blank" rel="noreferrer"
                href={`https://${location.hostname}:8006/?console=kvm&novnc=1&vmid=${g.vmid}&vmname=${encodeURIComponent(g.name)}&node=${encodeURIComponent(g.node)}&resize=scale`}>
                <span className={`dot ${health(g)}`} />
                <span className="name">{g.name}</span>
                <span className="mono muted">{kindLabel(g)} {g.vmid} ↗</span>
              </a>
            ))}
          </>
        )}
      </div>
      <div className="console-main">
        {cur ? <Terminal key={`${cur.node}-${cur.kind}-${cur.vmid ?? 0}`} target={cur} /> : <p className="muted">Nenhum nó online.</p>}
      </div>
    </div>
  );
}

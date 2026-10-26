import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { kindLabel, health } from "./format";
import { IconGrid, IconMinimize, IconX } from "./icons";
import { Terminal, type ConsoleTarget } from "./Terminal";
import { VncConsole } from "./VncConsole";
import { useGuests, useStatus, useUI, type ConsoleSession } from "./state";

const same = (a: ConsoleTarget | null | undefined, b: ConsoleTarget) =>
  a?.node === b.node && a?.kind === b.kind && (a?.vmid ?? 0) === (b.vmid ?? 0);

const where = (t: ConsoleTarget) => (t.kind === "node" ? `shell · ${t.node}` : `${t.kind === "qemu" ? "VM" : "CT"} ${t.vmid} · ${t.node}`);

const dot = (c: ConsoleSession) => (c.status === "connected" ? "running" : c.status === "connecting" ? "paused" : "stopped");

const SPLIT_KEY = "mia.console.split";

/** Posição da área da página Console, pra encaixar os consoles nela. */
function useRect(el: HTMLElement | null) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!el) return setRect(null);
    const up = () => setRect(el.getBoundingClientRect());
    up();
    const ro = new ResizeObserver(up);
    ro.observe(el);
    window.addEventListener("resize", up);
    window.addEventListener("scroll", up, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", up);
      window.removeEventListener("scroll", up, true);
    };
  }, [el]);
  return rect;
}

/**
 * Consoles abertos de qualquer lugar (loja, guest, painel do nó, página
 * Console). Vários ao mesmo tempo: abas, ou lado a lado. Fechar a janela só
 * minimiza: o terminal continua conectado, e o que roda nele (instalação de
 * app, atualização) segue até terminar. Na página Console as mesmas sessões
 * aparecem embutidas, então trocar de página não derruba nada.
 */
export function ConsoleModal() {
  const ui = useUI();
  const qc = useQueryClient();
  const embedded = !!ui.consoleSlot;
  const rect = useRect(ui.consoleSlot);
  const active = ui.consoles.find((c) => c.id === ui.activeConsole) ?? (embedded ? ui.consoles[ui.consoles.length - 1] : null) ?? null;
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [split, setSplit] = useState(() => {
    try {
      return localStorage.getItem(SPLIT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSplit = () => {
    setSplit(!split);
    try {
      localStorage.setItem(SPLIT_KEY, split ? "0" : "1");
    } catch {
      /* sem storage */
    }
  };

  const refresh = () => {
    // O que rodou no console pode ter criado guests.
    for (const k of ["guests", "overview", "status", "node", "myapps"]) qc.invalidateQueries({ queryKey: [k] });
  };
  const minimize = () => {
    setPicking(false);
    ui.showConsole(null);
    refresh();
  };
  const end = (id: string) => {
    setConfirmEnd(null);
    ui.closeConsole(id);
    refresh();
  };
  const askEnd = (c: ConsoleSession) => (c.status === "connected" ? setConfirmEnd(c.id) : end(c.id));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc vai pro terminal (vim, nano); minimizar é ⌘/Ctrl+Shift+X.
      if (!embedded && ui.activeConsole && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x") minimize();
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

  if (!ui.consoles.length) return null;
  const visible = embedded ? !!rect : !!active;
  const asking = ui.consoles.find((c) => c.id === confirmEnd);
  const n = ui.consoles.length;
  const tiled = split && n > 1;

  return (
    <>
      {/* O mesmo elemento em todos os modos: trocar de modo não remonta os terminais. */}
      <div
        className={embedded ? "console-embed" : "overlay console-overlay"}
        style={!visible ? { display: "none" } : embedded && rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : undefined}
      >
        <div className="console-modal" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label="Consoles">
          <div className="console-head">
            <div className="console-tabs" role="tablist">
              {ui.consoles.map((c) => (
                <div key={c.id} className={`console-tab ${c.id === active?.id ? "on" : ""}`}>
                  <button role="tab" aria-selected={c.id === active?.id} className="console-tab-open" title={where(c.target)}
                    onClick={() => ui.showConsole(c.id)}>
                    <span className={`dot ${dot(c)}`} />
                    <span className="console-tab-title">{c.target.title}</span>
                  </button>
                  <button className="console-tab-x" aria-label={`Encerrar ${c.target.title}`} title="Encerrar sessão" onClick={() => askEnd(c)}>
                    <IconX width={12} height={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="console-add">
                <button className="console-tab-new" aria-label="Abrir outro console" title="Abrir outro console" aria-expanded={picking}
                  onClick={() => setPicking(!picking)}>+</button>
                {picking && (
                  <Picker current={active?.target} onClose={() => setPicking(false)}
                    onPick={(t) => { setPicking(false); ui.openConsole(t); }} />
                )}
            </div>
            <span className="console-actions">
              {n > 1 && (
                <button className={`btn small split-btn ${split ? "on" : ""}`} aria-pressed={split} onClick={toggleSplit} title="Ver todos ao mesmo tempo">
                  <IconGrid width={14} height={14} /> Lado a lado
                </button>
              )}
              {!embedded && (
                <button className="close" onClick={minimize} aria-label="Minimizar" title="Minimizar: as sessões continuam rodando (⌘⇧X)">
                  <IconMinimize />
                </button>
              )}
            </span>
          </div>
          {asking && (
            <div className="console-warn">
              Encerrar “{asking.target.title}”? Fecha o terminal no Proxmox e interrompe o que estiver rodando nele.
              <button className="btn small danger" onClick={() => end(asking.id)}>Encerrar</button>
              <button className="btn small" onClick={() => setConfirmEnd(null)}>Cancelar</button>
            </div>
          )}
          <div className={`console-panes ${tiled ? "split" : ""}`} style={tiled ? { gridTemplateColumns: `repeat(${n > 4 ? 3 : 2}, minmax(0, 1fr))` } : undefined}>
            {ui.consoles.map((c) => {
              const t = c.target;
              const on = c.id === active?.id;
              return (
                <div key={c.id} className={`console-pane ${on ? "on" : ""}`} style={!tiled && !on ? { display: "none" } : undefined}
                  onMouseDown={() => !on && ui.showConsole(c.id)}>
                  {tiled && (
                    <div className="pane-head">
                      <span className={`dot ${dot(c)}`} />
                      <b>{t.title}</b>
                      <span className="mono">{where(t)}</span>
                    </div>
                  )}
                  {t.kind === "qemu"
                    ? <VncConsole target={t} onStatus={(st) => ui.setConsoleStatus(c.id, st)} />
                    : <Terminal target={t} onStatus={(st) => ui.setConsoleStatus(c.id, st)} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {!embedded && !active && (
        <div className="console-dock" role="region" aria-label="Terminais abertos">
          {ui.consoles.map((c) => (
            <div key={c.id} className="dock-item">
              <button className="dock-open" onClick={() => ui.showConsole(c.id)} title="Abrir">
                <span className={`dot ${dot(c)}`} />
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

/** Menu do "+": outro terminal no mesmo lugar, ou qualquer nó/guest ligado. */
function Picker({ current, onPick, onClose }: { current?: ConsoleTarget; onPick: (t: ConsoleTarget) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  return (
    <div className="console-picker" ref={box}>
      {current && current.kind !== "qemu" && (
        <button className="list-btn" onClick={() => onPick({ node: current.node, kind: current.kind, vmid: current.vmid, title: current.title })}>
          <span className="name">Outro terminal em {current.title}</span>
          <span className="mono muted">{current.kind === "node" ? "shell" : current.vmid}</span>
        </button>
      )}
      <Targets onPick={onPick} />
    </div>
  );
}

/** Nós e guests ligados, de onde dá pra abrir console. */
function Targets({ onPick, pressed }: { onPick: (t: ConsoleTarget) => void; pressed?: (t: ConsoleTarget) => boolean }) {
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const nodes = status?.nodes ?? [];
  const lxcs = (guests ?? []).filter((g) => g.type === "lxc" && !g.template);
  const vms = (guests ?? []).filter((g) => g.type === "qemu" && !g.template);
  return (
    <>
      <div className="side-title">Nós</div>
      {nodes.map((n) => {
        const t: ConsoleTarget = { node: n.name, kind: "node", title: n.name };
        return (
          <button key={n.name} className="list-btn" aria-pressed={pressed?.(t)} disabled={!n.online} onClick={() => onPick(t)}>
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
          <button key={g.id} className="list-btn" aria-pressed={pressed?.(t)} disabled={g.status !== "running"}
            onClick={() => onPick(t)} title={g.status !== "running" ? "Parado" : undefined}>
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
              <button key={g.id} className="list-btn" aria-pressed={pressed?.(t)} disabled={g.status !== "running"}
                onClick={() => onPick(t)} title={g.status !== "running" ? "Desligada" : undefined}>
                <span className={`dot ${health(g)}`} />
                <span className="name">{g.name}</span>
                <span className="mono muted">{kindLabel(g)} {g.vmid}</span>
              </button>
            );
          })}
        </>
      )}
    </>
  );
}

/**
 * Página Console: escolhe onde abrir à esquerda; as sessões (as mesmas da
 * janela de console) ficam embutidas à direita, em abas ou lado a lado.
 */
export function ConsolePage() {
  const ui = useUI();
  const { data: status } = useStatus();
  const { setConsoleSlot, showConsole, openConsole } = ui;
  const active = ui.consoles.find((c) => c.id === ui.activeConsole) ?? ui.consoles[ui.consoles.length - 1];

  // Saindo da página, as sessões continuam e vão pra barra de terminais.
  useEffect(() => () => showConsole(null), [showConsole]);

  // Primeira visita sem nada aberto: abre o shell do primeiro nó online.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !status) return;
    started.current = true;
    const n = status.nodes.find((x) => x.online);
    if (!ui.consoles.length && n) openConsole({ node: n.name, kind: "node", title: n.name });
  }, [status, ui.consoles.length, openConsole]);

  // Clicar num lugar já aberto volta pra ele; pra um segundo terminal no mesmo lugar, use o "+".
  const pick = (t: ConsoleTarget) => {
    const open = ui.consoles.find((c) => same(c.target, t) && !c.target.autorun && !c.target.cmd);
    if (open) showConsole(open.id);
    else openConsole(t);
  };

  return (
    <div className="content console-page">
      <div className="console-side">
        <Targets onPick={pick} pressed={(t) => same(active?.target, t)} />
      </div>
      <div className="console-main" ref={setConsoleSlot}>
        {!ui.consoles.length && <p className="muted">Escolha um nó ou guest pra abrir um console.</p>}
      </div>
    </div>
  );
}

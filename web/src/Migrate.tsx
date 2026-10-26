import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Guest } from "./api";
import { Modal } from "./Dialogs";
import { kindLabel } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useGuests, useStatus } from "./state";

/**
 * Migra um ou vários guests pra outro nó. VM rodando vai ao vivo; LXC
 * rodando é desligado, movido e ligado de novo (o Proxmox não migra LXC ao vivo).
 */
export function MigrateDialog({ node, only, onClose }: { node: string; only?: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const targets = (status?.nodes ?? []).filter((n) => n.online && n.name !== node);
  const list = only ? [only] : (guests ?? []).filter((g) => g.node === node && !g.template);
  const [pick, setPick] = useState<Set<string>>(new Set(only ? [only.id] : []));
  const [target, setTarget] = useState(targets[0]?.name ?? "");
  const [runs, setRuns] = useState<{ g: Guest; upid?: string; error?: string }[] | null>(null);

  const go = async () => {
    const chosen = list.filter((g) => pick.has(g.id));
    const out: { g: Guest; upid?: string; error?: string }[] = [];
    for (const g of chosen) {
      try {
        out.push({ g, upid: (await api.migrate(g, target)).upid });
      } catch (e) {
        out.push({ g, error: (e as Error).message });
      }
    }
    setRuns(out);
  };
  const done = () => {
    for (const k of ["guests", "overview", "status", "node"]) qc.invalidateQueries({ queryKey: [k] });
  };

  return (
    <Modal label="Migrar guests" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{only ? `Migrar ${only.name}` : `Migrar guests de ${node}`}</h2>
      <div className="dialog-sub">VM vai ao vivo; LXC é desligado, movido e ligado de novo</div>
      {runs ? (
        <>
          {runs.map((r) => (
            <div key={r.g.id} style={{ marginTop: 12 }}>
              <b style={{ fontSize: 13 }}>{r.g.name}</b>
              {r.upid ? <TaskLog upid={r.upid} onDone={done} /> : <div className="err">{r.error}</div>}
            </div>
          ))}
          <div className="dialog-actions"><button className="btn" onClick={onClose}>Fechar</button></div>
        </>
      ) : !targets.length ? (
        <p className="muted">Precisa de outro nó online no cluster pra migrar.</p>
      ) : (
        <>
          <label className="field">
            Para o nó
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((n) => <option key={n.name}>{n.name}</option>)}
            </select>
          </label>
          {!only && (
            <div className="guest-picks" style={{ marginTop: 14 }}>
              {list.map((g) => (
                <label key={g.id} className={`pick ${pick.has(g.id) ? "on" : ""}`}>
                  <input type="checkbox" checked={pick.has(g.id)} onChange={() => {
                    const n = new Set(pick);
                    if (n.has(g.id)) n.delete(g.id);
                    else n.add(g.id);
                    setPick(n);
                  }} />
                  <span className="mono">{kindLabel(g)} {g.vmid}</span> {g.name} <span className="muted">· {g.status}</span>
                </label>
              ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12 }}>Discos em storage local são copiados pela rede; pode demorar.</p>
          <div className="dialog-actions">
            <button className="btn primary" disabled={!pick.size || !target} onClick={go}>Migrar {pick.size > 1 ? `${pick.size} guests` : ""}</button>
            <button className="btn" onClick={onClose}>Cancelar</button>
          </div>
        </>
      )}
    </Modal>
  );
}

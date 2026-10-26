import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest } from "./api";
import { Modal } from "./Dialogs";
import { bytes, kindLabel } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useStatus, useUI } from "./state";

const refreshAll = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ["guests", "overview", "status", "node"]) qc.invalidateQueries({ queryKey: [k] });
};

/** Clonar (ou criar a partir de um template). */
export function CloneDialog({ g, onClose }: { g: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const ui = useUI();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [name, setName] = useState(`${g.name}-${g.template ? "1" : "copia"}`.replace(/[^a-zA-Z0-9-]/g, "-"));
  const [full, setFull] = useState(!g.template);
  const [target, setTarget] = useState(g.node);
  const [storage, setStorage] = useState("");
  const { data: cfg } = useQuery({ queryKey: ["guest-config", g.id], queryFn: () => api.guestConfig(g) });
  const run = useMutation({ mutationFn: () => api.clone(g, { name, full, target, storage }) });

  return (
    <Modal label="Clonar" onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{g.template ? `Novo ${kindLabel(g)} a partir de ${g.name}` : `Clonar ${g.name}`}</h2>
      <div className="dialog-sub">{kindLabel(g)} {g.vmid} · {g.node}</div>
      {run.data ? (
        <>
          <TaskLog upid={run.data.upid} onDone={() => refreshAll(qc)} />
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => { onClose(); ui.openGuest(`${g.type}/${run.data!.vmid}`); }}>Abrir o novo</button>
            <button className="btn" onClick={onClose}>Fechar</button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <label className="field">Nome<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
          {g.template && (
            <div className="field">
              Tipo de cópia
              <div className="radio-row">
                <label><input type="radio" checked={!full} onChange={() => setFull(false)} />Ligada<small>instantânea, depende do template</small></label>
                <label><input type="radio" checked={full} onChange={() => setFull(true)} />Completa<small>independente, ocupa o espaço todo</small></label>
              </div>
            </div>
          )}
          <div className="form-grid">
            {nodes.length > 1 && (
              <label className="field">Nó
                <select value={target} onChange={(e) => setTarget(e.target.value)}>{nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select>
              </label>
            )}
            {full && (
              <label className="field">Storage
                <select value={storage} onChange={(e) => setStorage(e.target.value)}>
                  <option value="">o mesmo do original</option>
                  {(cfg?.storages ?? []).map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {bytes(s.avail)} livres</option>)}
                </select>
              </label>
            )}
          </div>
          {run.error && <div className="err">{(run.error as Error).message}</div>}
          <div className="dialog-actions">
            <button className="btn primary" disabled={!name || run.isPending}>{g.template ? "Criar" : "Clonar"}</button>
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Apagar de vez: pede o nome digitado. */
export function DestroyDialog({ g, onClose }: { g: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const ui = useUI();
  const [typed, setTyped] = useState("");
  const run = useMutation({ mutationFn: () => api.destroy(g, typed) });
  return (
    <Modal label="Apagar" onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Apagar {g.name}</h2>
      <div className="dialog-sub">{kindLabel(g)} {g.vmid} · {g.node}</div>
      {run.data ? (
        <>
          <TaskLog upid={run.data.upid} onDone={() => { refreshAll(qc); ui.openGuest(null); }} />
          <div className="dialog-actions"><button className="btn" onClick={onClose}>Fechar</button></div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <div className="warn">
            Apaga o {kindLabel(g)} e <b>todos os discos dele</b>. Backups e snapshots em outros storages não são tocados.
            Não tem como desfazer.
          </div>
          <label className="field">Digite <b className="mono">{g.name}</b> pra confirmar<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
          {run.error && <div className="err">{(run.error as Error).message}</div>}
          <div className="dialog-actions">
            <button className="btn danger" disabled={typed !== g.name || run.isPending}>Apagar de vez</button>
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

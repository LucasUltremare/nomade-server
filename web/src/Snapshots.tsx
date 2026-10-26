import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest } from "./api";
import { TaskLog } from "./Tasks";

function defaultName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `mia_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Snapshots do guest: criar, voltar pra um, apagar. */
export function Snapshots({ g }: { g: Guest }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ["snapshots", g.id], queryFn: () => api.snapshots(g) });
  const [name, setName] = useState(defaultName);
  const [desc, setDesc] = useState("");
  const [ram, setRam] = useState(false);
  const [upid, setUpid] = useState("");
  const [armed, setArmed] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["snapshots", g.id] });
    qc.invalidateQueries({ queryKey: ["guests"] });
  };
  const done = (r: { upid: string }) => { setArmed(""); setUpid(r.upid); };
  const create = useMutation({
    mutationFn: () => api.snapshotCreate(g, { name, description: desc, ram }),
    onSuccess: (r) => { done(r); setName(defaultName()); setDesc(""); },
  });
  const rollback = useMutation({ mutationFn: (n: string) => api.snapshotRollback(g, n), onSuccess: done });
  const del = useMutation({ mutationFn: (n: string) => api.snapshotDelete(g, n), onSuccess: done });
  const err = create.error || rollback.error || del.error;
  const list = (data ?? []).filter((s) => !s.current);

  return (
    <div className="snaps">
      <form className="snap-form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label className="field">Nome<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Descrição<input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ex.: antes de atualizar" /></label>
        <button className="btn primary small" disabled={create.isPending || !name}>Tirar snapshot</button>
        {g.type === "qemu" && g.status === "running" && (
          <label className="check"><input type="checkbox" checked={ram} onChange={(e) => setRam(e.target.checked)} />Incluir a RAM (volta com os programas abertos)</label>
        )}
      </form>

      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      <ol className="snap-list">
        {list.map((s) => (
          <li key={s.name}>
            <span className="snap-dot" />
            <div className="snap-main">
              <b>{s.name}{s.ram && <span className="chip-mini">com RAM</span>}</b>
              <span className="muted">{s.description || "sem descrição"} · {new Date(s.time * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
            <div className="snap-actions">
              {armed === `r:${s.name}` ? (
                <button className="btn small primary" onClick={() => rollback.mutate(s.name)}>Confirmar volta</button>
              ) : (
                <button className="btn small" onClick={() => setArmed(`r:${s.name}`)}>Voltar pra cá</button>
              )}
              {armed === `d:${s.name}` ? (
                <button className="btn small danger" onClick={() => del.mutate(s.name)}>Confirmar</button>
              ) : (
                <button className="btn small" onClick={() => setArmed(`d:${s.name}`)}>Apagar</button>
              )}
            </div>
          </li>
        ))}
        <li className="snap-now"><span className="snap-dot" /><div className="snap-main"><b>Agora</b><span className="muted">estado atual</span></div></li>
      </ol>
      {armed.startsWith("r:") && (
        <div className="warn">Voltar descarta tudo que mudou depois desse snapshot, inclusive arquivos.</div>
      )}
      {list.length === 0 && data && <p className="muted" style={{ fontSize: 13 }}>Nenhum snapshot ainda. Tire um antes de mexer em algo arriscado.</p>}
      {err && <div className="err">{(err as Error).message}</div>}
      {upid && <TaskLog key={upid} upid={upid} onDone={refresh} />}
      <p className="muted" style={{ fontSize: 12 }}>Snapshot precisa de storage que suporte (ZFS, LVM-thin, Ceph ou qcow2). Não substitui backup.</p>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Disk, type Guest } from "./api";
import { bytes } from "./format";
import { TaskLog } from "./Tasks";

/** CPU, memória e discos de um guest já criado. */
export function GuestHardware({ g }: { g: Guest }) {
  const qc = useQueryClient();
  const { data: cfg, error, isLoading } = useQuery({
    queryKey: ["guest-config", g.id],
    queryFn: () => api.guestConfig(g),
  });
  const [upid, setUpid] = useState("");
  const [err, setErr] = useState("");
  const refresh = () => {
    for (const k of [["guest-config", g.id], ["guests"], ["overview"], ["node"]]) qc.invalidateQueries({ queryKey: k });
  };
  const after = (r: { upid?: string }) => {
    setErr("");
    if (r.upid) setUpid(r.upid);
    refresh();
  };
  const fail = (e: Error) => setErr(e.message);

  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!cfg) return null;

  return (
    <div className="hw">
      <Resources g={g} cores={cfg.cores} memory={cfg.memory} swap={cfg.swap} onDone={after} onError={fail} />
      {cfg.pending.length > 0 && (
        <div className="warn">Mudanças esperando reiniciar: {cfg.pending.join(", ")}</div>
      )}

      <div className="hw-title">Discos</div>
      <div className="disk-list">
        {cfg.disks.map((d) => (
          <DiskRow key={d.key} g={g} d={d} storages={cfg.storages.map((s) => s.storage)} running={cfg.status === "running"}
            onDone={after} onError={fail} />
        ))}
      </div>
      <AddDisk g={g} storages={cfg.storages} onDone={after} onError={fail} />
      {cfg.hasCd && <CdRom g={g} current={cfg.cdrom} onDone={after} onError={fail} />}

      {err && <div className="err">{err}</div>}
      {upid && <TaskLog key={upid} upid={upid} onDone={refresh} />}
    </div>
  );
}

type Done = (r: { upid?: string }) => void;
type Fail = (e: Error) => void;

function Resources({ g, cores, memory, swap, onDone, onError }: {
  g: Guest; cores: number; memory: number; swap: number; onDone: Done; onError: Fail;
}) {
  const [c, setC] = useState(cores);
  const [m, setM] = useState(memory);
  const [s, setS] = useState(swap);
  useEffect(() => { setC(cores); setM(memory); setS(swap); }, [cores, memory, swap]);
  const save = useMutation({ mutationFn: () => api.guestResources(g, { cores: c, memory: m, swap: s }), onSuccess: onDone, onError });
  const changed = c !== cores || m !== memory || s !== swap;
  return (
    <form className="hw-res" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label className="field">CPU<input type="number" min={1} max={512} value={c} onChange={(e) => setC(+e.target.value)} /></label>
      <label className="field">RAM (MB)<input type="number" min={16} value={m} onChange={(e) => setM(+e.target.value)} /></label>
      {g.type === "lxc" && <label className="field">Swap (MB)<input type="number" min={0} value={s} onChange={(e) => setS(+e.target.value)} /></label>}
      <button className="btn primary small" disabled={!changed || save.isPending}>Salvar</button>
    </form>
  );
}

function DiskRow({ g, d, storages, running, onDone, onError }: {
  g: Guest; d: Disk; storages: string[]; running: boolean; onDone: Done; onError: Fail;
}) {
  const [mode, setMode] = useState<"" | "resize" | "move" | "remove">("");
  const [add, setAdd] = useState(4);
  const [target, setTarget] = useState(storages.find((s) => s !== d.storage) ?? "");
  const resize = useMutation({ mutationFn: () => api.diskResize(g, d.key, add), onSuccess: (r) => { setMode(""); onDone(r); }, onError });
  const move = useMutation({ mutationFn: () => api.diskMove(g, d.key, target), onSuccess: (r) => { setMode(""); onDone(r); }, onError });
  const remove = useMutation({ mutationFn: () => api.diskRemove(g, d.key), onSuccess: (r) => { setMode(""); onDone(r); }, onError });
  const label = d.key === "rootfs" ? "Disco raiz" : d.unused ? "Disco solto" : d.key;

  return (
    <div className={`disk ${d.unused ? "unused" : ""}`}>
      <div className="disk-main">
        <div>
          <b>{label}</b>
          <span className="mono muted"> {d.mountpoint ?? ""}</span>
        </div>
        <div className="mono muted disk-vol">{d.volume}</div>
      </div>
      <div className="disk-size mono">{d.size ? bytes(d.size) : "—"}</div>
      <div className="disk-actions">
        {!d.unused && !d.bind && <button className="btn small" onClick={() => setMode(mode === "resize" ? "" : "resize")}>Aumentar</button>}
        {!d.bind && storages.length > 1 && <button className="btn small" onClick={() => setMode(mode === "move" ? "" : "move")}>Mover</button>}
        {d.key !== "rootfs" && <button className="btn small danger" onClick={() => setMode(mode === "remove" ? "" : "remove")}>{d.unused ? "Apagar" : "Desanexar"}</button>}
      </div>

      {mode === "resize" && (
        <form className="disk-form" onSubmit={(e) => { e.preventDefault(); resize.mutate(); }}>
          <span>Aumentar em</span>
          <input type="number" min={1} max={65536} value={add} onChange={(e) => setAdd(+e.target.value)} aria-label="GB a mais" />
          <span>GB</span>
          <button className="btn small primary" disabled={resize.isPending}>Aumentar</button>
          <small className="muted">O Proxmox não diminui disco.</small>
        </form>
      )}
      {mode === "move" && (
        <form className="disk-form" onSubmit={(e) => { e.preventDefault(); move.mutate(); }}>
          <span>Mover para</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Storage de destino">
            {storages.filter((s) => s !== d.storage).map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn small primary" disabled={!target || move.isPending}>Mover</button>
          {g.type === "lxc" && running && <small className="muted">Contêiner precisa estar desligado.</small>}
        </form>
      )}
      {mode === "remove" && (
        <div className="disk-form">
          <span>{d.unused ? "Apaga o volume do storage de vez." : "Tira o disco do guest; ele fica como “disco solto” e não é apagado."}</span>
          <button className="btn small danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {d.unused ? "Apagar de vez" : "Desanexar"}
          </button>
        </div>
      )}
    </div>
  );
}

function CdRom({ g, current, onDone, onError }: { g: Guest; current: string; onDone: Done; onError: Fail }) {
  const { data: opts } = useQuery({ queryKey: ["vm-options", g.node], queryFn: () => api.vmOptions(g.node) });
  const [iso, setIso] = useState(current);
  useEffect(() => setIso(current), [current]);
  const save = useMutation({ mutationFn: () => api.setCdrom(g, iso), onSuccess: onDone, onError });
  return (
    <>
      <div className="hw-title">CD / DVD</div>
      <form className="disk cd" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <select value={iso} onChange={(e) => setIso(e.target.value)} aria-label="ISO no CD">
          <option value="">Vazio</option>
          {current && !opts?.isos.some((i) => i.volid === current) && <option value={current}>{current}</option>}
          {opts?.isos.map((i) => <option key={i.volid} value={i.volid}>{i.name}</option>)}
        </select>
        <button className="btn small primary" disabled={iso === current || save.isPending}>{iso ? "Colocar" : "Ejetar"}</button>
      </form>
    </>
  );
}

function AddDisk({ g, storages, onDone, onError }: {
  g: Guest; storages: { storage: string; avail: number }[]; onDone: Done; onError: Fail;
}) {
  const [open, setOpen] = useState(false);
  const [storage, setStorage] = useState(storages[0]?.storage ?? "");
  const [size, setSize] = useState(32);
  const [path, setPath] = useState("/data");
  const [backup, setBackup] = useState(true);
  const add = useMutation({
    mutationFn: () => api.diskAdd(g, { storage, size, path, backup }),
    onSuccess: (r) => { setOpen(false); onDone(r); },
    onError,
  });
  if (!open) {
    return <button className="btn small" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
      {g.type === "lxc" ? "Adicionar ponto de montagem" : "Adicionar disco"}
    </button>;
  }
  return (
    <form className="disk-add" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <label className="field">
        Storage
        <select value={storage} onChange={(e) => setStorage(e.target.value)}>
          {storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {bytes(s.avail)} livres</option>)}
        </select>
      </label>
      <label className="field">Tamanho (GB)<input type="number" min={1} value={size} onChange={(e) => setSize(+e.target.value)} /></label>
      {g.type === "lxc" && <label className="field">Montar em<input value={path} onChange={(e) => setPath(e.target.value)} /></label>}
      <label className="check"><input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />Incluir no backup</label>
      <div className="dialog-actions" style={{ marginTop: 10 }}>
        <button className="btn small primary" disabled={!storage || add.isPending}>Adicionar</button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>Cancelar</button>
      </div>
    </form>
  );
}

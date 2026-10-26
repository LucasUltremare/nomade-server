import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uploadFile, type StorageRow, type Volume } from "./api";
import { Modal } from "./Dialogs";
import { bytes, bytesPair } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";

const CONTENT_SHORT: Record<string, string> = {
  iso: "ISO", vztmpl: "templates", backup: "backup", images: "VMs", rootdir: "CTs", import: "import", snippets: "snippets",
};

const CONTENT_LABEL: Record<string, string> = {
  iso: "ISOs", vztmpl: "Templates", backup: "Backups", images: "Discos de VM", rootdir: "Discos de CT", import: "Importar", snippets: "Snippets",
};

export function StoragePage() {
  const { data, error, isLoading } = useQuery({ queryKey: ["storages"], queryFn: api.storages, refetchInterval: 30_000 });
  const [sel, setSel] = useState<StorageRow | null>(null);

  // Storage compartilhado aparece uma vez só (o primeiro nó que vê ele).
  const rows: StorageRow[] = [];
  const seenShared = new Set<string>();
  for (const s of data?.storages ?? []) {
    if (s.shared) {
      if (seenShared.has(s.storage)) continue;
      seenShared.add(s.storage);
    }
    rows.push(s);
  }
  const current = sel ?? rows[0] ?? null;

  return (
    <div className="content">
      <h1>Armazenamento</h1>
      <span className="tag">{rows.length} storages</span>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}

      <div className="store-grid">
        {rows.map((s) => {
          const frac = s.total ? s.used / s.total : 0;
          const active = current && current.storage === s.storage && current.node === s.node;
          return (
            <button key={`${s.node}/${s.storage}`} className="card store-card" aria-pressed={!!active} onClick={() => setSel(s)}>
              <div className="card-top">
                <span>{s.shared ? "compartilhado" : s.node} · {s.type}</span>
                <span className={`dot ${s.active ? (frac > 0.9 ? "hot" : "running") : "stopped"}`} />
              </div>
              <div className="card-name">{s.storage}</div>
              <div className={`bar ${frac > 0.9 ? "hot" : ""}`}><i style={{ width: `${frac * 100}%` }} /></div>
              <div className="card-foot">
                <span>{s.content.map((c) => CONTENT_SHORT[c] ?? c).join(" · ")}</span>
                <span>{s.total ? bytesPair(s.used, s.total) : "—"}</span>
              </div>
            </button>
          );
        })}
      </div>

      {current && <StorageContent key={`${current.node}/${current.storage}`} st={current} />}
    </div>
  );
}

function StorageContent({ st }: { st: StorageRow }) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["content", st.node, st.storage],
    queryFn: () => api.storageContent(st.node, st.storage),
  });
  const kinds = st.content.filter((c) => CONTENT_LABEL[c]);
  const [tab, setTab] = useState(kinds.includes("iso") ? "iso" : kinds[0] ?? "");
  const [upid, setUpid] = useState("");
  const [confirm, setConfirm] = useState("");
  const [dialog, setDialog] = useState<"upload" | "url" | Volume | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["content", st.node, st.storage] });
    qc.invalidateQueries({ queryKey: ["storages"] });
  };
  const del = useMutation({
    mutationFn: (v: Volume) => api.deleteVolume(st.node, st.storage, v.volid),
    onSuccess: (r) => {
      setConfirm("");
      if (r.upid) setUpid(r.upid);
      refresh();
    },
  });
  const list = (data ?? []).filter((v) => v.content === tab);
  const canUpload = tab === "iso" || tab === "vztmpl" || tab === "import";

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{st.storage}</h2>
          <p>{st.shared ? "compartilhado entre os nós" : `no nó ${st.node}`} · {bytes(st.avail)} livres</p>
        </div>
        {canUpload && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn small" onClick={() => setDialog("url")}>Baixar de URL</button>
            <button className="btn small primary" onClick={() => setDialog("upload")}>Enviar arquivo</button>
          </div>
        )}
      </div>
      <div className="seg" role="group" aria-label="Conteúdo">
        {kinds.map((k) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {CONTENT_LABEL[k]} <span className="muted">{(data ?? []).filter((v) => v.content === k).length}</span>
          </button>
        ))}
      </div>
      {upid && <div style={{ marginTop: 12 }}><TaskLog upid={upid} onDone={refresh} /></div>}
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Nome</th>{(tab === "backup" || tab === "images" || tab === "rootdir") && <th>Guest</th>}<th className="num">Tamanho</th><th>Data</th><th /></tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.volid} style={{ cursor: "default" }}>
                  <td className="mono" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>{v.name}{v.protected && <span className="muted"> · protegido</span>}</td>
                  {(tab === "backup" || tab === "images" || tab === "rootdir") && <td className="mono">{v.vmid || "—"}</td>}
                  <td className="num">{bytes(v.size)}</td>
                  <td className="mono">{v.ctime ? new Date(v.ctime * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {tab === "backup" && <button className="btn small" onClick={() => setDialog(v)}>Restaurar</button>}{" "}
                    {tab !== "images" && tab !== "rootdir" && !v.protected && (confirm === v.volid ? (
                      <button className="btn small danger" onClick={() => del.mutate(v)} disabled={del.isPending}>Confirmar</button>
                    ) : (
                      <button className="btn small" onClick={() => setConfirm(v.volid)}>Apagar</button>
                    ))}
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={5} className="muted">Nada aqui.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {del.error && <div className="err">{(del.error as Error).message}</div>}
      {tab === "images" || tab === "rootdir" ? (
        <p className="muted" style={{ fontSize: 12 }}>Discos de guests são gerenciados pelo próprio guest; apague o guest pra liberar.</p>
      ) : null}

      {dialog === "upload" && <UploadDialog st={st} content={tab} onClose={() => setDialog(null)} onStarted={(u) => { setUpid(u); setDialog(null); }} />}
      {dialog === "url" && <URLDialog st={st} content={tab} onClose={() => setDialog(null)} onStarted={(u) => { setUpid(u); setDialog(null); }} />}
      {dialog && typeof dialog === "object" && <RestoreDialog st={st} vol={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}

function UploadDialog({ st, content, onClose, onStarted }: { st: StorageRow; content: string; onClose: () => void; onStarted: (upid: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const send = async () => {
    if (!file) return;
    setErr("");
    setProgress(0);
    try {
      const r = await uploadFile(st.node, st.storage, content, file, setProgress);
      onStarted(r.upid);
    } catch (e) {
      setErr((e as Error).message);
      setProgress(null);
    }
  };
  return (
    <Modal label="Enviar arquivo" onClose={progress === null ? onClose : () => {}}>
      <button className="close" onClick={onClose} aria-label="Fechar" disabled={progress !== null}><IconX /></button>
      <h2>Enviar {content === "iso" ? "ISO" : content === "vztmpl" ? "template" : "arquivo"}</h2>
      <div className="dialog-sub">{st.storage} · {st.node}</div>
      <div className="dropzone" onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0] ?? null); }}>
        {file ? <><b>{file.name}</b><span className="muted">{bytes(file.size)}</span></> : <span className="muted">Clique ou arraste o arquivo aqui</span>}
        <input ref={input} type="file" hidden accept={content === "iso" ? ".iso,.img" : content === "vztmpl" ? ".tar.gz,.tar.xz,.tar.zst" : undefined}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {progress !== null && (
        <div className="meter" style={{ marginTop: 14 }}>
          <div className="meter-head"><span>Enviando</span><span className="mono">{Math.round(progress * 100)}%</span></div>
          <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="dialog-actions">
        <button className="btn primary" onClick={send} disabled={!file || progress !== null}>Enviar</button>
        <button className="btn" onClick={onClose} disabled={progress !== null}>Cancelar</button>
      </div>
    </Modal>
  );
}

function URLDialog({ st, content, onClose, onStarted }: { st: StorageRow; content: string; onClose: () => void; onStarted: (upid: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const go = useMutation({
    mutationFn: () => api.downloadURL(st.node, st.storage, { url, filename: name, content }),
    onSuccess: (r) => onStarted(r.upid),
  });
  const guess = (u: string) => {
    try {
      return decodeURIComponent(new URL(u).pathname.split("/").pop() ?? "");
    } catch {
      return "";
    }
  };
  return (
    <Modal label="Baixar de URL" onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Baixar de URL</h2>
      <div className="dialog-sub">o próprio nó baixa, direto no {st.storage}</div>
      <form onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <label className="field">URL<input value={url} placeholder="https://cdimage.debian.org/…/debian-13.iso"
          onChange={(e) => { setUrl(e.target.value); if (!name || name === guess(url)) setName(guess(e.target.value)); }} /></label>
        <label className="field">Nome do arquivo<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {go.error && <div className="err">{(go.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={!url || !name || go.isPending}>Baixar</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

function RestoreDialog({ st, vol, onClose }: { st: StorageRow; vol: Volume; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["storages"], queryFn: api.storages });
  const kind: "lxc" | "qemu" = vol.subtype === "qemu" ? "qemu" : "lxc";
  const nodes = data?.nodes ?? [st.node];
  const [node, setNode] = useState(st.shared ? nodes[0] : st.node);
  const targets = (data?.storages ?? []).filter((s) => s.node === node && s.active && s.content.includes(kind === "lxc" ? "rootdir" : "images"));
  const [storage, setStorage] = useState("");
  const [start, setStart] = useState(false);
  const target = storage || targets[0]?.storage || "";
  const run = useMutation({ mutationFn: () => api.restore(node, { volid: vol.volid, kind, storage: target, start }) });
  return (
    <Modal label="Restaurar backup" onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>Restaurar backup</h2>
      <div className="dialog-sub">{vol.name}</div>
      {run.data ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Restaurando como {kind === "lxc" ? "CT" : "VM"} {run.data.vmid}…</p>
          <TaskLog upid={run.data.upid} onDone={() => { for (const k of ["guests", "overview", "status"]) qc.invalidateQueries({ queryKey: [k] }); }} />
          <div className="dialog-actions"><button className="btn" onClick={onClose}>Fechar</button></div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
            Cria um {kind === "lxc" ? "contêiner" : "VM"} <b>novo</b> com o próximo ID livre. O guest original{vol.vmid ? ` (${vol.vmid})` : ""} não é tocado.
          </p>
          <div className="form-grid">
            {st.shared && (
              <label className="field">Nó<select value={node} onChange={(e) => { setNode(e.target.value); setStorage(""); }}>{nodes.map((n) => <option key={n}>{n}</option>)}</select></label>
            )}
            <label className="field">Storage de destino
              <select value={target} onChange={(e) => setStorage(e.target.value)}>
                {targets.map((t) => <option key={t.storage} value={t.storage}>{t.storage} · {bytes(t.avail)} livres</option>)}
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />Ligar depois de restaurar</label>
          {run.error && <div className="err">{(run.error as Error).message}</div>}
          <div className="dialog-actions">
            <button className="btn primary" disabled={!target || run.isPending}>Restaurar</button>
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

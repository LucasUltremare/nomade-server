import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type VmRequest } from "./api";
import { Modal } from "./Dialogs";
import { bytes } from "./format";
import { IconX } from "./icons";
import { navigate } from "./router";
import { TaskLog } from "./Tasks";
import { useStatus, useUI } from "./state";

const PRESETS: Record<VmRequest["os"], { label: string; hint: string; cores: number; memory: number; disk: number }> = {
  linux: { label: "Linux", hint: "Debian, Ubuntu, Fedora…", cores: 2, memory: 2048, disk: 32 },
  win11: { label: "Windows 11", hint: "UEFI, TPM 2.0 e Secure Boot já configurados", cores: 4, memory: 8192, disk: 64 },
  win10: { label: "Windows 10", hint: "UEFI", cores: 4, memory: 4096, disk: 64 },
  other: { label: "Outro", hint: "BSD, appliance, etc.", cores: 2, memory: 2048, disk: 16 },
};

/** Criar VM a partir de uma ISO, com padrões por sistema. */
export function NewVmDialog() {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const open = ui.newVm !== null;
  const [node, setNode] = useState("");
  const [f, setF] = useState<VmRequest>({
    vmid: 0, name: "", os: "linux", iso: "", cores: 2, memory: 2048, disk: 32, storage: "", bridge: "vmbr0", vlan: 0, start: true, onboot: false,
  });
  const [job, setJob] = useState<{ upid: string; vmid: number } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setNode(ui.newVm || ui.node || nodes[0]?.name || "");
      setJob(null);
      setErr("");
    }
  }, [open]); // só ao abrir

  const { data: opts, isLoading } = useQuery({ queryKey: ["vm-options", node], queryFn: () => api.vmOptions(node), enabled: open && !!node });
  useEffect(() => {
    if (!opts) return;
    setF((x) => ({
      ...x,
      vmid: opts.nextid,
      storage: opts.disks.some((d) => d.storage === x.storage) ? x.storage : opts.disks[0]?.storage ?? "",
      bridge: opts.bridges.some((b) => b.iface === x.bridge) ? x.bridge : opts.bridges[0]?.iface ?? "",
      iso: opts.isos.some((i) => i.volid === x.iso) ? x.iso : "",
    }));
  }, [opts]);

  if (!open) return null;
  const set = <K extends keyof VmRequest>(k: K, v: VmRequest[K]) => setF((x) => ({ ...x, [k]: v }));
  const pickOS = (os: VmRequest["os"]) => setF((x) => ({ ...x, os, cores: PRESETS[os].cores, memory: PRESETS[os].memory, disk: PRESETS[os].disk }));
  const close = () => ui.setNewVm(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      setJob(await api.createVm(node, f));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal label="Nova máquina virtual" onClose={close} className="wide">
      <button className="close" onClick={close} aria-label="Fechar"><IconX /></button>
      <h2>Nova máquina virtual</h2>
      <div className="dialog-sub">instala a partir de uma ISO, pelo console gráfico</div>

      {job ? (
        <>
          <TaskLog upid={job.upid} onDone={() => { for (const k of ["guests", "overview", "status", "node"]) qc.invalidateQueries({ queryKey: [k] }); }} />
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => { close(); ui.openConsole({ node, kind: "qemu", vmid: job.vmid, title: f.name }); }}>
              Abrir o console
            </button>
            <button className="btn" onClick={() => { close(); ui.openGuest(`qemu/${job.vmid}`); }}>Ver a VM</button>
          </div>
          {f.os.startsWith("win") && (
            <p className="muted" style={{ fontSize: 12 }}>
              Depois de instalar, coloque os drivers VirtIO (ISO virtio-win) pra rede e disco rápidos.
            </p>
          )}
        </>
      ) : (
        <form onSubmit={submit}>
          {isLoading && <p className="muted">Carregando opções do nó…</p>}
          <div className="os-picks">
            {(Object.keys(PRESETS) as VmRequest["os"][]).map((k) => (
              <button type="button" key={k} className={`os-pick ${f.os === k ? "on" : ""}`} onClick={() => pickOS(k)} aria-pressed={f.os === k}>
                <b>{PRESETS[k].label}</b><span>{PRESETS[k].hint}</span>
              </button>
            ))}
          </div>
          <div className="form-grid">
            <label className="field">Nó
              <select value={node} onChange={(e) => setNode(e.target.value)}>{nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select>
            </label>
            <label className="field">ID<input type="number" min={100} value={f.vmid || ""} onChange={(e) => set("vmid", +e.target.value)} /></label>
            <label className="field span2">Nome<input value={f.name} onChange={(e) => set("name", e.target.value.toLowerCase())} placeholder="ex.: debian-dev" required /></label>
            <label className="field span2">
              ISO de instalação
              <select value={f.iso} onChange={(e) => set("iso", e.target.value)}>
                <option value="">Sem ISO (coloco depois)</option>
                {opts?.isos.map((i) => <option key={i.volid} value={i.volid}>{i.name} ({bytes(i.size)})</option>)}
              </select>
              <small className="muted">
                Não tem a ISO? <a href="/armazenamento" onClick={(e) => { e.preventDefault(); close(); navigate("/armazenamento"); }}>Envie ou baixe em Armazenamento</a>.
              </small>
            </label>
            <label className="field">CPU<input type="number" min={1} max={128} value={f.cores} onChange={(e) => set("cores", +e.target.value)} /></label>
            <label className="field">RAM (MB)<input type="number" min={256} value={f.memory} onChange={(e) => set("memory", +e.target.value)} /></label>
            <label className="field">Disco (GB)<input type="number" min={1} value={f.disk} onChange={(e) => set("disk", +e.target.value)} /></label>
            <label className="field">Storage
              <select value={f.storage} onChange={(e) => set("storage", e.target.value)}>
                {opts?.disks.map((d) => <option key={d.storage} value={d.storage}>{d.storage} · {bytes(d.avail)} livres</option>)}
              </select>
            </label>
            <label className="field">Bridge
              <select value={f.bridge} onChange={(e) => set("bridge", e.target.value)}>
                {opts?.bridges.map((b) => <option key={b.iface} value={b.iface}>{b.iface}{b.cidr ? ` · ${b.cidr}` : ""}</option>)}
              </select>
            </label>
            <label className="field">VLAN<input type="number" min={0} max={4094} value={f.vlan || ""} placeholder="nenhuma" onChange={(e) => set("vlan", +e.target.value)} /></label>
          </div>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={f.start} onChange={(e) => set("start", e.target.checked)} />Ligar depois de criar</label>
            <label className="check"><input type="checkbox" checked={f.onboot} onChange={(e) => set("onboot", e.target.checked)} />Iniciar com o nó</label>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="dialog-actions">
            <button className="btn primary" disabled={!opts || !f.name}>Criar VM</button>
            <button type="button" className="btn" onClick={close}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

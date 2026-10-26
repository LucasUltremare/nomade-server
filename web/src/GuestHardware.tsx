import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Device, type Disk, type Guest } from "./api";
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
      {g.type === "qemu" && <VmSettings g={g} opts={cfg.options} onDone={after} onError={fail} />}
      {g.type === "lxc" && <CpuLimits g={g} opts={cfg.options} onDone={after} onError={fail} />}
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
      <Devices g={g} devices={cfg.devices} onDone={after} onError={fail} />

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
  const [mode, setMode] = useState<"" | "resize" | "move" | "remove" | "opts">("");
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
        {!d.unused && <button className="btn small" onClick={() => setMode(mode === "opts" ? "" : "opts")}>Opções</button>}
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
      {mode === "opts" && <DiskOpts g={g} d={d} onDone={(r) => { setMode(""); onDone(r); }} onError={onError} />}
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

function DiskOpts({ g, d, onDone, onError }: { g: Guest; d: Disk; onDone: Done; onError: Fail }) {
  const vm = g.type === "qemu";
  const [o, setO] = useState<Record<string, string>>({
    cache: d.opts.cache ?? "", discard: d.opts.discard ?? "", iothread: d.opts.iothread ?? "", ssd: d.opts.ssd ?? "",
    backup: d.opts.backup ?? (d.key === "rootfs" ? "" : "1"), mountoptions: d.opts.mountoptions ?? "",
  });
  const save = useMutation({
    mutationFn: () => {
      const diff: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if ((d.opts[k] ?? "") !== v && (vm || ["backup", "mountoptions"].includes(k))) diff[k] = v;
      return api.diskOptions(g, d.key, diff);
    },
    onSuccess: onDone, onError,
  });
  const flag = (k: string, label: string) => (
    <label className="check"><input type="checkbox" checked={o[k] === "1" || o[k] === "on"} onChange={(e) => setO((x) => ({ ...x, [k]: e.target.checked ? (k === "discard" ? "on" : "1") : (k === "backup" ? "0" : "") }))} />{label}</label>
  );
  return (
    <form className="disk-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {vm && (
        <select value={o.cache} onChange={(e) => setO((x) => ({ ...x, cache: e.target.value }))} aria-label="Cache">
          <option value="">Cache padrão (nenhum)</option><option value="writeback">Write back</option><option value="writethrough">Write through</option>
          <option value="directsync">Direct sync</option><option value="unsafe">Unsafe</option>
        </select>
      )}
      {vm && flag("discard", "Discard (TRIM)")}
      {vm && flag("iothread", "IO thread")}
      {vm && flag("ssd", "Emular SSD")}
      {d.key !== "rootfs" && flag("backup", "Incluir no backup")}
      {!vm && d.key !== "rootfs" && (
        <input value={o.mountoptions} onChange={(e) => setO((x) => ({ ...x, mountoptions: e.target.value }))} placeholder="noatime;nosuid" aria-label="Opções de montagem" style={{ width: 150 }} />
      )}
      <button className="btn small primary" disabled={save.isPending}>Salvar</button>
      {vm && <small className="muted">Vale no próximo boot da VM.</small>}
    </form>
  );
}

const CPU_TYPES = [["host", "host (máximo desempenho)"], ["x86-64-v2-AES", "x86-64-v2-AES (padrão, migra entre CPUs)"], ["x86-64-v3", "x86-64-v3"], ["x86-64-v4", "x86-64-v4"], ["kvm64", "kvm64 (compatível)"], ["qemu64", "qemu64"]];

function VmSettings({ g, opts, onDone, onError }: { g: Guest; opts: Record<string, string>; onDone: Done; onError: Fail }) {
  const cur = { cpu: (opts.cpu ?? "x86-64-v2-AES").split(",")[0], balloon: opts.balloon ?? "", bios: opts.bios ?? "seabios", machine: (opts.machine ?? "pc").startsWith("pc-q35") || opts.machine === "q35" ? "q35" : "pc", vga: (opts.vga ?? "std").split(",")[0] };
  const [v, setV] = useState(cur);
  const curKey = JSON.stringify(cur);
  useEffect(() => setV(cur), [curKey]); // volta pro salvo quando o config recarrega
  const save = useMutation({
    mutationFn: () => {
      const diff: Record<string, string> = {};
      for (const k of Object.keys(cur) as (keyof typeof cur)[]) if (v[k] !== cur[k]) diff[k] = v[k];
      return api.guestOptions(g, diff);
    },
    onSuccess: onDone, onError,
  });
  const changed = JSON.stringify(v) !== JSON.stringify(cur);
  return (
    <>
      <div className="hw-title">Sistema</div>
      <form className="vm-settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="field">Tipo de CPU
          <select value={v.cpu} onChange={(e) => setV({ ...v, cpu: e.target.value })}>
            {CPU_TYPES.map(([a, b]) => <option key={a} value={a}>{b}</option>)}
            {!CPU_TYPES.some(([a]) => a === v.cpu) && <option value={v.cpu}>{v.cpu}</option>}
          </select>
        </label>
        <label className="field">RAM mínima (balloon, MB)<input type="number" min={0} value={v.balloon} placeholder="igual à RAM" onChange={(e) => setV({ ...v, balloon: e.target.value })} /></label>
        <label className="field">BIOS
          <select value={v.bios} onChange={(e) => setV({ ...v, bios: e.target.value })}><option value="seabios">SeaBIOS (legado)</option><option value="ovmf">OVMF (UEFI)</option></select>
        </label>
        <label className="field">Máquina
          <select value={v.machine} onChange={(e) => setV({ ...v, machine: e.target.value })}><option value="pc">i440fx</option><option value="q35">q35 (PCIe)</option></select>
        </label>
        <label className="field">Tela
          <select value={v.vga} onChange={(e) => setV({ ...v, vga: e.target.value })}>
            {[["std", "Padrão"], ["virtio", "VirtIO-GPU"], ["qxl", "SPICE (qxl)"], ["vmware", "VMware"], ["serial0", "Terminal serial"], ["none", "Nenhuma"]].map(([a, b]) => <option key={a} value={a}>{b}</option>)}
          </select>
        </label>
        <button className="btn small primary" disabled={!changed || save.isPending}>Salvar</button>
      </form>
      {v.bios === "ovmf" && !opts.efidisk0 && <div className="warn">UEFI precisa de um disco EFI. Adicione pelo Proxmox ou crie a VM de novo com o preset Windows/UEFI.</div>}
    </>
  );
}

function CpuLimits({ g, opts, onDone, onError }: { g: Guest; opts: Record<string, string>; onDone: Done; onError: Fail }) {
  const [limit, setLimit] = useState(opts.cpulimit ?? "");
  const [units, setUnits] = useState(opts.cpuunits ?? "");
  useEffect(() => { setLimit(opts.cpulimit ?? ""); setUnits(opts.cpuunits ?? ""); }, [opts.cpulimit, opts.cpuunits]);
  const save = useMutation({ mutationFn: () => api.guestOptions(g, { cpulimit: limit, cpuunits: units }), onSuccess: onDone, onError });
  return (
    <form className="hw-res" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label className="field">Limite de CPU<input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="sem limite (ex.: 1.5)" /></label>
      <label className="field">Peso de CPU<input value={units} onChange={(e) => setUnits(e.target.value)} placeholder="100" /></label>
      <button className="btn small primary" disabled={(limit === (opts.cpulimit ?? "") && units === (opts.cpuunits ?? "")) || save.isPending}>Salvar</button>
    </form>
  );
}

function Devices({ g, devices, onDone, onError }: { g: Guest; devices: Device[]; onDone: Done; onError: Fail }) {
  const vm = g.type === "qemu";
  const { data: hw } = useQuery({ queryKey: ["hardware", g.node], queryFn: () => api.hardware(g.node), enabled: vm });
  const [adding, setAdding] = useState<"" | "usb" | "pci" | "serial" | "dev">("");
  const [pick, setPick] = useState("");
  const [pcie, setPcie] = useState(true);
  const [all, setAll] = useState(true);
  const [path, setPath] = useState("/dev/dri/renderD128");
  const [gid, setGid] = useState("");
  const [confirm, setConfirm] = useState("");
  const add = useMutation({
    mutationFn: () => api.guestDevice(g, adding === "dev" ? { kind: "dev", path, gid } : { kind: adding, host: pick, pcie, allFunctions: all }),
    onSuccess: (r) => { setAdding(""); setPick(""); onDone(r); }, onError,
  });
  const del = useMutation({ mutationFn: (k: string) => api.configDelete(g, k), onSuccess: (r) => { setConfirm(""); onDone(r); }, onError });
  const describe = (d: Device) => {
    if (d.kind === "usb") {
      const id = d.value.replace("host=", "").split(",")[0];
      const u = hw?.usb.find((x) => `${x.vendid}:${x.prodid}` === id || x.usbpath === id);
      return u ? `${u.manufacturer ?? ""} ${u.product ?? id}` : d.value;
    }
    if (d.kind === "pci") {
      const id = d.value.split(",")[0];
      const p = hw?.pci.find((x) => x.id.startsWith(id.includes(":") && id.split(":").length === 2 ? `0000:${id}` : id));
      return p ? `${p.device_name ?? id} (${id})` : d.value;
    }
    return d.value;
  };
  return (
    <>
      <div className="hw-title">{vm ? "Dispositivos (USB, PCI, serial)" : "Dispositivos do host"}</div>
      <div className="disk-list">
        {devices.map((d) => (
          <div key={d.key} className="disk">
            <div className="disk-main"><div><b>{d.key}</b></div><div className="mono muted disk-vol">{describe(d)}</div></div>
            <div />
            <div className="disk-actions">
              {confirm === d.key
                ? <button className="btn small danger" onClick={() => del.mutate(d.key)}>Confirmar</button>
                : <button className="btn small danger" onClick={() => setConfirm(d.key)}>Remover</button>}
            </div>
          </div>
        ))}
      </div>
      {!adding ? (
        <div className="ts-row" style={{ marginTop: 10 }}>
          {vm ? (
            <>
              <button className="btn small" onClick={() => setAdding("usb")}>Adicionar USB</button>
              <button className="btn small" onClick={() => setAdding("pci")}>Adicionar PCI</button>
              <button className="btn small" onClick={() => setAdding("serial")}>Adicionar porta serial</button>
            </>
          ) : (
            <button className="btn small" onClick={() => setAdding("dev")}>Passar dispositivo pro contêiner</button>
          )}
        </div>
      ) : (
        <form className="disk-add" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          {adding === "usb" && (
            <label className="field span-all">Dispositivo USB
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Escolha…</option>
                {hw?.usb.filter((u) => !/hub/i.test(u.product ?? "")).map((u) => (
                  <option key={`${u.vendid}:${u.prodid}:${u.usbpath}`} value={`${u.vendid}:${u.prodid}`}>{u.manufacturer} {u.product} ({u.vendid}:{u.prodid})</option>
                ))}
              </select>
            </label>
          )}
          {adding === "pci" && (
            <>
              <label className="field span-all">Placa PCI
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Escolha…</option>
                  {hw?.pci.filter((p) => !p.class.startsWith("0x06")).map((p) => (
                    <option key={p.id} value={p.id}>{p.device_name ?? p.id} · {p.vendor_name} · grupo IOMMU {p.iommugroup ?? "?"}</option>
                  ))}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Todas as funções (vídeo + áudio da placa)</label>
              <label className="check"><input type="checkbox" checked={pcie} onChange={(e) => setPcie(e.target.checked)} />PCI Express (máquina q35)</label>
              {hw?.pci.length && hw.pci.every((p) => p.iommugroup === undefined || p.iommugroup === -1) && (
                <div className="warn span-all">IOMMU parece desligado: ative VT-d/AMD-Vi na BIOS e intel_iommu=on no kernel.</div>
              )}
            </>
          )}
          {adding === "serial" && <p className="muted span-all" style={{ fontSize: 13 }}>Cria uma porta serial (socket), útil pra console de texto e pra Home Assistant OS.</p>}
          {adding === "dev" && (
            <>
              <label className="field">Caminho
                <input value={path} onChange={(e) => setPath(e.target.value)} list="dev-presets" />
                <datalist id="dev-presets">
                  {["/dev/dri/renderD128", "/dev/dri/card0", "/dev/net/tun", "/dev/ttyUSB0", "/dev/ttyACM0", "/dev/kvm", "/dev/fuse"].map((x) => <option key={x} value={x} />)}
                </datalist>
              </label>
              <label className="field">GID dentro do CT<input value={gid} onChange={(e) => setGid(e.target.value)} placeholder="ex.: 104 (grupo render)" /></label>
              <p className="muted span-all" style={{ fontSize: 12 }}>Pra GPU, use o GID do grupo <span className="mono">render</span> do contêiner (<span className="mono">getent group render</span>). Vale no próximo boot.</p>
            </>
          )}
          <div className="dialog-actions span-all" style={{ marginTop: 8 }}>
            <button className="btn small primary" disabled={add.isPending || ((adding === "usb" || adding === "pci") && !pick)}>Adicionar</button>
            <button type="button" className="btn small" onClick={() => setAdding("")}>Cancelar</button>
          </div>
        </form>
      )}
    </>
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

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LxcRequest } from "./api";
import { Modal } from "./Dialogs";
import { bytes } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useStatus, useUI } from "./state";

type Step = { kind: "form" } | { kind: "download"; upid: string } | { kind: "create"; upid: string; vmid: number };

const DOWNLOAD = "download:";

/** Criar LXC pela API: escolhe template (baixando se precisar), recursos e rede. */
export function NewLxcDialog() {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const nodes = (status?.nodes ?? []).filter((n) => n.online);
  const [node, setNode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [err, setErr] = useState("");
  const [f, setF] = useState<LxcRequest>({
    vmid: 0, hostname: "", template: "", cores: 2, memory: 2048, swap: 512, disk: 8, storage: "", bridge: "vmbr0",
    ip: "dhcp", gateway: "", vlan: 0, password: "", sshKeys: "", unprivileged: true, nesting: true, tun: false,
    start: true, onboot: true, tags: "",
  });
  const [tmplStore, setTmplStore] = useState("");
  const [staticIP, setStaticIP] = useState(false);

  const open = ui.newLxc !== null;
  useEffect(() => {
    if (open) {
      setNode(ui.newLxc || ui.node || nodes[0]?.name || "");
      setStep({ kind: "form" });
      setErr("");
    }
  }, [open]); // só ao abrir: reabrir não deve sobrescrever o que o usuário trocou

  const { data: opts, isLoading } = useQuery({
    queryKey: ["lxc-options", node],
    queryFn: () => api.lxcOptions(node),
    enabled: open && !!node,
  });

  // Padrões a partir das opções do nó.
  useEffect(() => {
    if (!opts) return;
    setF((x) => ({
      ...x,
      vmid: opts.nextid,
      storage: opts.rootfs.some((s) => s.storage === x.storage) ? x.storage : opts.rootfs[0]?.storage ?? "",
      bridge: opts.bridges.some((b) => b.iface === x.bridge) ? x.bridge : opts.bridges[0]?.iface ?? "",
      template: x.template || opts.templates[0]?.volid || (opts.available[0] ? DOWNLOAD + opts.available[0].template : ""),
    }));
    setTmplStore((s) => s || opts.templateStorages[0]?.storage || "");
  }, [opts]);

  const set = <K extends keyof LxcRequest>(k: K, v: LxcRequest[K]) => setF((x) => ({ ...x, [k]: v }));
  const downloaded = useMemo(() => new Set(opts?.templates.map((t) => t.name)), [opts]);

  if (!open) return null;
  const close = () => {
    ui.setNewLxc(null);
    setStep({ kind: "form" });
  };
  const refresh = () => {
    for (const k of ["guests", "overview", "status", "node", "lxc-options"]) qc.invalidateQueries({ queryKey: [k] });
  };

  const create = async (template: string) => {
    try {
      const r = await api.createLxc(node, { ...f, template, ip: staticIP ? f.ip : "dhcp", gateway: staticIP ? f.gateway : "" });
      setStep({ kind: "create", upid: r.upid, vmid: r.vmid });
    } catch (e) {
      setErr((e as Error).message);
      setStep({ kind: "form" });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (f.template.startsWith(DOWNLOAD)) {
      if (!tmplStore) return setErr("Nenhum storage aceita templates nesse nó.");
      try {
        const r = await api.downloadTemplate(node, tmplStore, f.template.slice(DOWNLOAD.length));
        setStep({ kind: "download", upid: r.upid });
      } catch (e) {
        setErr((e as Error).message);
      }
      return;
    }
    create(f.template);
  };

  return (
    <Modal label="Novo contêiner LXC" onClose={close} className="wide">
      <button className="close" onClick={close} aria-label="Fechar"><IconX /></button>
      <h2>Novo contêiner LXC</h2>
      <div className="dialog-sub">criado pela API do Proxmox, como no painel dele</div>

      {step.kind === "download" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Baixando o template…</p>
          <TaskLog upid={step.upid} onDone={(ok) => {
            if (!ok) return setErr("O download do template falhou.");
            create(`${tmplStore}:vztmpl/${f.template.slice(DOWNLOAD.length)}`);
          }} />
          {err && <div className="err">{err}</div>}
        </>
      )}

      {step.kind === "create" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Criando o CT {step.vmid}…</p>
          <TaskLog upid={step.upid} onDone={refresh} />
          <div className="dialog-actions">
            <button className="btn primary" onClick={() => {
              close();
              ui.openGuest(`lxc/${step.vmid}`);
            }}>Abrir o CT</button>
            <button className="btn" onClick={close}>Fechar</button>
          </div>
        </>
      )}

      {step.kind === "form" && (
        <form onSubmit={submit}>
          {isLoading && <p className="muted">Carregando opções do nó…</p>}
          <div className="form-grid">
            <label className="field">
              Nó
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                {nodes.map((n) => <option key={n.name}>{n.name}</option>)}
              </select>
            </label>
            <label className="field">ID<input type="number" min={100} value={f.vmid || ""} onChange={(e) => set("vmid", +e.target.value)} /></label>
            <label className="field span2">
              Nome (hostname)
              <input value={f.hostname} onChange={(e) => set("hostname", e.target.value.toLowerCase())} placeholder="ex.: pihole" required />
            </label>
            <label className="field span2">
              Sistema
              <select value={f.template} onChange={(e) => set("template", e.target.value)}>
                {opts && opts.templates.length > 0 && (
                  <optgroup label="Já baixados">
                    {opts.templates.map((t) => <option key={t.volid} value={t.volid}>{t.name} ({bytes(t.size)})</option>)}
                  </optgroup>
                )}
                {opts && (
                  <optgroup label="Baixar do Proxmox">
                    {opts.available.filter((a) => !downloaded.has(a.template)).map((a) => (
                      <option key={a.template} value={DOWNLOAD + a.template}>{a.headline} · {a.version}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="field">CPU<input type="number" min={1} max={128} value={f.cores} onChange={(e) => set("cores", +e.target.value)} /></label>
            <label className="field">RAM (MB)<input type="number" min={64} value={f.memory} onChange={(e) => set("memory", +e.target.value)} /></label>
            <label className="field">Swap (MB)<input type="number" min={0} value={f.swap} onChange={(e) => set("swap", +e.target.value)} /></label>
            <label className="field">Disco (GB)<input type="number" min={1} value={f.disk} onChange={(e) => set("disk", +e.target.value)} /></label>
            <label className="field span2">
              Storage do disco
              <select value={f.storage} onChange={(e) => set("storage", e.target.value)}>
                {opts?.rootfs.map((s) => <option key={s.storage} value={s.storage}>{s.storage} · {s.type} · {bytes(s.avail)} livres</option>)}
              </select>
            </label>
            <label className="field">
              Bridge
              <select value={f.bridge} onChange={(e) => set("bridge", e.target.value)}>
                {opts?.bridges.map((b) => <option key={b.iface} value={b.iface}>{b.iface}{b.cidr ? ` · ${b.cidr}` : ""}{b.comments ? ` · ${b.comments}` : ""}</option>)}
              </select>
            </label>
            <label className="field">VLAN<input type="number" min={0} max={4094} value={f.vlan || ""} placeholder="nenhuma" onChange={(e) => set("vlan", +e.target.value)} /></label>
            <div className="field span2">
              IP
              <div className="radio-row">
                <label><input type="radio" checked={!staticIP} onChange={() => setStaticIP(false)} />DHCP</label>
                <label><input type="radio" checked={staticIP} onChange={() => { setStaticIP(true); if (f.ip === "dhcp") set("ip", ""); }} />Fixo</label>
              </div>
            </div>
            {staticIP && (
              <>
                <label className="field">Endereço/prefixo<input value={f.ip} onChange={(e) => set("ip", e.target.value)} placeholder="10.0.10.50/24" /></label>
                <label className="field">Gateway<input value={f.gateway} onChange={(e) => set("gateway", e.target.value)} placeholder="10.0.10.1" /></label>
              </>
            )}
            <label className="field span2">
              Senha do root
              <input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
            </label>
            <label className="field span2">
              Chave SSH pública <small className="muted">(opcional)</small>
              <input value={f.sshKeys} onChange={(e) => set("sshKeys", e.target.value)} placeholder="ssh-ed25519 AAAA…" />
            </label>
            <label className="field span2">Tags<input value={f.tags} onChange={(e) => set("tags", e.target.value)} placeholder="ex.: dns;rede" /></label>
          </div>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={f.unprivileged} onChange={(e) => set("unprivileged", e.target.checked)} />Sem privilégios (recomendado)</label>
            <label className="check"><input type="checkbox" checked={f.nesting} onChange={(e) => set("nesting", e.target.checked)} />Nesting (Docker, systemd moderno)</label>
            <label className="check"><input type="checkbox" checked={f.tun} onChange={(e) => set("tun", e.target.checked)} />/dev/net/tun (VPN, Tailscale)</label>
            <label className="check"><input type="checkbox" checked={f.onboot} onChange={(e) => set("onboot", e.target.checked)} />Iniciar com o nó</label>
            <label className="check"><input type="checkbox" checked={f.start} onChange={(e) => set("start", e.target.checked)} />Ligar depois de criar</label>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="dialog-actions">
            <button className="btn primary" disabled={!opts || !f.hostname || !f.template}>
              {f.template.startsWith(DOWNLOAD) ? "Baixar template e criar" : "Criar contêiner"}
            </button>
            <button type="button" className="btn" onClick={close}>Cancelar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

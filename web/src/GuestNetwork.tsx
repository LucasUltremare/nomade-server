import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest, type NetCard } from "./api";
import { TaskLog } from "./Tasks";

const useConfig = (g: Guest) => useQuery({ queryKey: ["guest-config", g.id], queryFn: () => api.guestConfig(g) });

function useRefresh(g: Guest) {
  const qc = useQueryClient();
  return () => {
    for (const k of [["guest-config", g.id], ["guests"], ["myapps"]]) qc.invalidateQueries({ queryKey: k });
  };
}

/** Placas de rede (e DNS no LXC). */
export function GuestNetwork({ g }: { g: Guest }) {
  const { data: cfg, error, isLoading } = useConfig(g);
  const { data: bridges } = useQuery({ queryKey: ["lxc-options", g.node], queryFn: () => api.lxcOptions(g.node) });
  const refresh = useRefresh(g);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState("");
  const del = useMutation({ mutationFn: (k: string) => api.configDelete(g, k), onSuccess: () => { setConfirmDel(""); refresh(); } });

  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!cfg) return null;
  const brs = bridges?.bridges.map((b) => b.iface) ?? ["vmbr0"];

  return (
    <div className="gnet">
      {cfg.nets.map((n) => (
        <div key={n.key} className="disk net">
          <div className="disk-main">
            <div>
              <b>{n.key}</b>
              <span className="mono muted"> {g.type === "lxc" ? n.name : n.model} · {n.bridge}{n.tag ? ` · VLAN ${n.tag}` : ""}{n.firewall ? " · firewall" : ""}{n.linkDown ? " · desconectada" : ""}</span>
            </div>
            <div className="mono muted disk-vol">
              {g.type === "lxc" ? `${n.ip || "sem IPv4"}${n.gw ? ` via ${n.gw}` : ""}${n.ip6 ? ` · v6 ${n.ip6}` : ""} · ` : ""}{n.mac}
            </div>
          </div>
          <div />
          <div className="disk-actions">
            <button className="btn small" onClick={() => setEditing(editing === n.key ? null : n.key)}>Editar</button>
            {confirmDel === n.key
              ? <button className="btn small danger" onClick={() => del.mutate(n.key)}>Confirmar</button>
              : <button className="btn small danger" onClick={() => setConfirmDel(n.key)}>Remover</button>}
          </div>
          {editing === n.key && <NetForm g={g} card={n} bridges={brs} onDone={() => { setEditing(null); refresh(); }} />}
        </div>
      ))}
      {!cfg.nets.length && <p className="muted" style={{ fontSize: 13 }}>Sem placa de rede.</p>}
      {editing === "new" ? (
        <div className="disk net"><NetForm g={g} bridges={brs} onDone={() => { setEditing(null); refresh(); }} /></div>
      ) : (
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => setEditing("new")}>Adicionar placa de rede</button>
      )}
      {del.error && <div className="err">{(del.error as Error).message}</div>}
      {g.type === "lxc" && <Dns g={g} ns={cfg.options.nameserver ?? ""} sd={cfg.options.searchdomain ?? ""} onDone={refresh} />}
      {g.status === "running" && g.type === "lxc" && (
        <p className="muted" style={{ fontSize: 12 }}>Mudança de IP vale na hora em contêiner rodando.</p>
      )}
    </div>
  );
}

function NetForm({ g, card, bridges, onDone }: { g: Guest; card?: NetCard; bridges: string[]; onDone: () => void }) {
  const lxc = g.type === "lxc";
  const [n, setN] = useState<Partial<NetCard>>(card ?? { bridge: bridges[0] ?? "vmbr0", model: "virtio", ip: "dhcp", firewall: true, tag: 0 });
  const [ipMode, setIpMode] = useState(n.ip === "dhcp" ? "dhcp" : n.ip ? "static" : "none");
  const set = <K extends keyof NetCard>(k: K, v: NetCard[K]) => setN((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.guestNet(g, card?.key ?? "new", { ...n, ip: lxc ? (ipMode === "dhcp" ? "dhcp" : ipMode === "none" ? "" : n.ip) : undefined, gw: lxc && ipMode === "static" ? n.gw : "" }),
    onSuccess: onDone,
  });
  return (
    <form className="net-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="form-grid">
        {lxc ? (
          <label className="field">Nome<input value={n.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="eth0" /></label>
        ) : (
          <label className="field">Modelo
            <select value={n.model} onChange={(e) => set("model", e.target.value)}>
              <option value="virtio">VirtIO (rápido)</option><option value="e1000e">Intel E1000E</option><option value="e1000">Intel E1000</option>
              <option value="vmxnet3">VMware vmxnet3</option><option value="rtl8139">Realtek RTL8139</option>
            </select>
          </label>
        )}
        <label className="field">Bridge
          <select value={n.bridge} onChange={(e) => set("bridge", e.target.value)}>{bridges.map((b) => <option key={b}>{b}</option>)}</select>
        </label>
        <label className="field">VLAN<input type="number" min={0} max={4094} value={n.tag || ""} placeholder="nenhuma" onChange={(e) => set("tag", +e.target.value)} /></label>
        <label className="field">MAC<input value={n.mac ?? ""} onChange={(e) => set("mac", e.target.value)} placeholder="automático" /></label>
        {lxc && (
          <>
            <div className="field span2">
              IPv4
              <div className="radio-row">
                {[["dhcp", "DHCP"], ["static", "Fixo"], ["none", "Nenhum"]].map(([v, l]) => (
                  <label key={v}><input type="radio" checked={ipMode === v} onChange={() => setIpMode(v)} />{l}</label>
                ))}
              </div>
            </div>
            {ipMode === "static" && (
              <>
                <label className="field">Endereço/prefixo<input value={n.ip === "dhcp" ? "" : n.ip ?? ""} onChange={(e) => set("ip", e.target.value)} placeholder="10.0.10.50/24" /></label>
                <label className="field">Gateway<input value={n.gw ?? ""} onChange={(e) => set("gw", e.target.value)} placeholder="10.0.10.1" /></label>
              </>
            )}
            <label className="field">IPv6
              <select value={n.ip6 ?? ""} onChange={(e) => set("ip6", e.target.value)}>
                <option value="">Nenhum</option><option value="auto">SLAAC</option><option value="dhcp">DHCPv6</option>
              </select>
            </label>
          </>
        )}
        <label className="field">Limite (MB/s)<input value={n.rate ?? ""} onChange={(e) => set("rate", e.target.value)} placeholder="sem limite" /></label>
        <label className="field">MTU<input value={n.mtu ?? ""} onChange={(e) => set("mtu", e.target.value)} placeholder="padrão" /></label>
      </div>
      <div className="checks">
        <label className="check"><input type="checkbox" checked={!!n.firewall} onChange={(e) => set("firewall", e.target.checked)} />Firewall nesta placa</label>
        <label className="check"><input type="checkbox" checked={!!n.linkDown} onChange={(e) => set("linkDown", e.target.checked)} />Desconectada (cabo puxado)</label>
      </div>
      {save.error && <div className="err">{(save.error as Error).message}</div>}
      <div className="dialog-actions"><button className="btn small primary" disabled={save.isPending}>Salvar</button></div>
    </form>
  );
}

function Dns({ g, ns, sd, onDone }: { g: Guest; ns: string; sd: string; onDone: () => void }) {
  const [a, setA] = useState(ns);
  const [b, setB] = useState(sd);
  useEffect(() => { setA(ns); setB(sd); }, [ns, sd]);
  const save = useMutation({ mutationFn: () => api.guestOptions(g, { nameserver: a, searchdomain: b }), onSuccess: onDone });
  return (
    <>
      <div className="hw-title">DNS</div>
      <form className="hw-res" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="field">Servidores<input value={a} onChange={(e) => setA(e.target.value)} placeholder="do host (ex.: 1.1.1.1 10.0.10.1)" /></label>
        <label className="field">Domínio de busca<input value={b} onChange={(e) => setB(e.target.value)} placeholder="do host (ex.: lan)" /></label>
        <button className="btn small primary" disabled={(a === ns && b === sd) || save.isPending}>Salvar</button>
      </form>
      {save.error && <div className="err">{(save.error as Error).message}</div>}
    </>
  );
}

const OSTYPES_VM = [["l26", "Linux 6.x/5.x"], ["win11", "Windows 11/2022/2025"], ["win10", "Windows 10/2016/2019"], ["other", "Outro"]];
const OSTYPES_CT = ["debian", "ubuntu", "alpine", "fedora", "centos", "archlinux", "opensuse", "nixos", "unmanaged"];

/** Opções: nome, boot, proteção, recursos do LXC, agente, notas. */
export function GuestOptions({ g }: { g: Guest }) {
  const { data: cfg, error, isLoading } = useConfig(g);
  const refresh = useRefresh(g);
  const [o, setO] = useState<Record<string, string>>({});
  const [upid, setUpid] = useState("");
  useEffect(() => { if (cfg) setO(cfg.options); }, [cfg]);
  const save = useMutation({
    mutationFn: () => {
      const diff: Record<string, string> = {};
      for (const k of new Set([...Object.keys(o), ...Object.keys(cfg!.options)])) {
        if (["unprivileged", "arch", "efidisk0", "tpmstate0", "sockets"].includes(k)) continue;
        if ((o[k] ?? "") !== (cfg!.options[k] ?? "")) diff[k] = o[k] ?? "";
      }
      return api.guestOptions(g, diff);
    },
    onSuccess: (r) => { if (r.upid) setUpid(r.upid); refresh(); },
  });
  if (isLoading) return <p className="muted">Carregando…</p>;
  if (error) return <div className="err">{(error as Error).message}</div>;
  if (!cfg) return null;
  const set = (k: string, v: string) => setO((x) => ({ ...x, [k]: v }));
  const startup: Record<string, string> = Object.fromEntries((o.startup ?? "").split(",").filter(Boolean).map((p) => p.split("=")));
  const setStartup = (k: string, v: string) => {
    const next = { ...startup, [k]: v };
    set("startup", ["order", "up", "down"].filter((x) => next[x]).map((x) => `${x}=${next[x]}`).join(","));
  };
  const feats: Record<string, string> = Object.fromEntries((o.features ?? "").split(",").filter(Boolean).map((p) => p.split("=")));
  const setFeat = (k: string, v: string) => {
    const next: Record<string, string> = { ...feats, [k]: v };
    set("features", Object.entries(next).filter(([, x]) => x && x !== "0").map(([a, b]) => `${a}=${b}`).join(","));
  };
  const mounts = (feats.mount ?? "").split(";").filter(Boolean);
  const toggleMount = (m: string) => setFeat("mount", (mounts.includes(m) ? mounts.filter((x) => x !== m) : [...mounts, m]).join(";"));
  const bootFirst = (o.boot ?? "").replace("order=", "").split(";")[0] ?? "";
  const bootDevs = [...cfg.disks.filter((d) => !d.unused).map((d) => d.key), ...(cfg.hasCd ? ["ide2"] : []), ...cfg.nets.map((n) => n.key)];
  const changed = JSON.stringify(o) !== JSON.stringify(cfg.options);

  return (
    <form className="gopts" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="form-grid">
        <label className="field">{g.type === "lxc" ? "Hostname" : "Nome"}
          <input value={o[g.type === "lxc" ? "hostname" : "name"] ?? ""} onChange={(e) => set(g.type === "lxc" ? "hostname" : "name", e.target.value.toLowerCase())} />
        </label>
        <label className="field">Tags<input value={o.tags ?? ""} onChange={(e) => set("tags", e.target.value.toLowerCase().replace(/[ ,]+/g, ";"))} placeholder="media;casa" /></label>
        <label className="field">Ordem de boot<input type="number" min={0} value={startup.order ?? ""} placeholder="qualquer" onChange={(e) => setStartup("order", e.target.value)} /></label>
        <label className="field">Esperar depois de ligar (s)<input type="number" min={0} value={startup.up ?? ""} placeholder="0" onChange={(e) => setStartup("up", e.target.value)} /></label>
        <label className="field">Sistema
          <select value={o.ostype ?? ""} onChange={(e) => set("ostype", e.target.value)}>
            {g.type === "qemu"
              ? OSTYPES_VM.map(([v, l]) => <option key={v} value={v}>{l}</option>)
              : OSTYPES_CT.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        {g.type === "qemu" && (
          <label className="field">Dá boot por
            <select value={bootFirst} onChange={(e) => set("boot", `order=${[e.target.value, ...bootDevs.filter((d) => d !== e.target.value)].join(";")}`)}>
              {bootDevs.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="checks">
        <label className="check"><input type="checkbox" checked={o.onboot === "1"} onChange={(e) => set("onboot", e.target.checked ? "1" : "")} />Iniciar junto com o nó</label>
        <label className="check"><input type="checkbox" checked={o.protection === "1"} onChange={(e) => set("protection", e.target.checked ? "1" : "")} />Proteção (impede apagar)</label>
        {g.type === "qemu" && (
          <label className="check"><input type="checkbox" checked={(o.agent ?? "").startsWith("1")} onChange={(e) => set("agent", e.target.checked ? "1" : "")} />Agente QEMU (IP e desligamento limpo)</label>
        )}
      </div>
      {g.type === "lxc" && (
        <>
          <div className="hw-title">Recursos do contêiner</div>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={feats.nesting === "1"} onChange={(e) => setFeat("nesting", e.target.checked ? "1" : "")} />Nesting (Docker, systemd)</label>
            <label className="check"><input type="checkbox" checked={feats.keyctl === "1"} onChange={(e) => setFeat("keyctl", e.target.checked ? "1" : "")} />keyctl (Docker sem privilégio)</label>
            <label className="check"><input type="checkbox" checked={feats.fuse === "1"} onChange={(e) => setFeat("fuse", e.target.checked ? "1" : "")} />FUSE</label>
            <label className="check"><input type="checkbox" checked={mounts.includes("nfs")} onChange={() => toggleMount("nfs")} />Montar NFS</label>
            <label className="check"><input type="checkbox" checked={mounts.includes("cifs")} onChange={() => toggleMount("cifs")} />Montar SMB/CIFS</label>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {cfg.options.unprivileged === "1" ? "Contêiner sem privilégios." : "Contêiner privilegiado."} Mudar recursos exige root@pam e vale no próximo boot.
          </p>
        </>
      )}
      <label className="field">Notas
        <textarea rows={4} value={o.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="Pra que serve, senhas de onde ficam, portas…" />
      </label>
      {save.error && <div className="err">{(save.error as Error).message}</div>}
      <div className="dialog-actions"><button className="btn primary" disabled={!changed || save.isPending}>Salvar opções</button></div>
      {upid && <TaskLog key={upid} upid={upid} />}
    </form>
  );
}

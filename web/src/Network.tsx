import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NetIface } from "./api";
import { Modal } from "./Dialogs";
import { bytes } from "./format";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";
import { useSettings, useStatus, useUI } from "./state";

const TYPE_LABEL: Record<string, string> = { bridge: "bridge", vlan: "VLAN", eth: "placa", bond: "bond", OVSBridge: "OVS bridge" };

export function NetworkPage() {
  const ui = useUI();
  const { data: status } = useStatus();
  const nodes = status?.nodes ?? [];
  const node = ui.node ?? nodes.find((n) => n.online)?.name ?? "";
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["network", node],
    queryFn: () => api.network(node),
    enabled: !!node,
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState<"bridge" | "vlan" | null>(null);
  const [applyUpid, setApplyUpid] = useState("");
  const [confirmDel, setConfirmDel] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["network", node] });

  const apply = useMutation({
    mutationFn: (op: "apply" | "revert") => api.networkApply(node, op),
    onSuccess: (r) => {
      if (r.upid) setApplyUpid(r.upid);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (iface: string) => api.networkDelete(node, iface),
    onSuccess: () => {
      setConfirmDel("");
      refresh();
    },
  });

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Rede</h1>
          <span className="tag">
            {node || "…"}
            {data?.traffic.in !== undefined && ` · ↓ ${bytes(data.traffic.in)}/s · ↑ ${bytes(data.traffic.out ?? 0)}/s`}
          </span>
        </div>
        <div className="seg" role="group" aria-label="Nó">
          {nodes.map((n) => (
            <button key={n.name} aria-pressed={n.name === node} disabled={!n.online} onClick={() => ui.setNode(n.name)}>{n.name}</button>
          ))}
        </div>
      </div>

      {data?.changes && (
        <div className="pending">
          <div className="pending-head">
            <b>Mudanças pendentes</b>
            <span className="muted">ainda não estão valendo no nó</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn small" onClick={() => apply.mutate("revert")} disabled={apply.isPending}>Descartar</button>
              <button className="btn small primary" onClick={() => apply.mutate("apply")} disabled={apply.isPending}>Aplicar</button>
            </span>
          </div>
          <pre className="diff">{data.changes.split("\n").map((l, i) => (
            <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l}{"\n"}</span>
          ))}</pre>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Aplicar recarrega a rede do nó (ifreload). Errar a bridge principal pode derrubar o acesso: confira antes.
          </p>
        </div>
      )}
      {apply.error && <div className="err">{(apply.error as Error).message}</div>}
      {applyUpid && <div style={{ marginTop: 12 }}><TaskLog upid={applyUpid} onDone={refresh} /></div>}

      <div className="section-head" style={{ marginTop: 28 }}>
        <h2>Interfaces</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small" onClick={() => setAdding("bridge")}>Nova bridge</button>
          <button className="btn small" onClick={() => setAdding("vlan")}>Nova VLAN</button>
        </div>
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Interface</th><th>Tipo</th><th>Ativa</th><th>Endereço</th><th>Gateway</th><th>Portas / base</th><th>Comentário</th><th /></tr>
            </thead>
            <tbody>
              {data.ifaces.map((i) => (
                <tr key={i.iface} style={{ cursor: "default" }}>
                  <td className="mono">{i.iface}{i.vlanAware && <span className="muted"> · vlan-aware</span>}</td>
                  <td>{TYPE_LABEL[i.type] ?? i.type}</td>
                  <td><span className="status"><span className={`dot ${i.active ? "running" : "stopped"}`} />{i.active ? "sim" : "não"}</span></td>
                  <td className="mono">{i.cidr || "—"}</td>
                  <td className="mono">{i.gateway || "—"}</td>
                  <td className="mono">{i.ports || (i.vlanRaw ? `${i.vlanRaw} · tag ${i.vlanId}` : "—")}</td>
                  <td>{i.comments}</td>
                  <td style={{ textAlign: "right" }}>
                    {deletable(i) && (confirmDel === i.iface ? (
                      <button className="btn small danger" onClick={() => del.mutate(i.iface)} disabled={del.isPending}>Confirmar</button>
                    ) : (
                      <button className="btn small" onClick={() => setConfirmDel(i.iface)}>Remover</button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {del.error && <div className="err">{(del.error as Error).message}</div>}

      <TailscaleCard node={node} bridges={(data?.ifaces ?? []).filter((i) => i.type === "bridge" && i.cidr)} />

      {adding && <AddIface node={node} type={adding} ifaces={data?.ifaces ?? []} onClose={() => { setAdding(null); refresh(); }} />}
    </div>
  );
}

// Placas físicas e a bridge com o gateway (a que dá acesso ao nó) ficam protegidas.
function deletable(i: NetIface) {
  return (i.type === "bridge" || i.type === "vlan") && !i.gateway;
}

function AddIface({ node, type, ifaces, onClose }: { node: string; type: "bridge" | "vlan"; ifaces: NetIface[]; onClose: () => void }) {
  const used = new Set(ifaces.map((i) => i.iface));
  let n = 0;
  while (used.has(`vmbr${n}`)) n++;
  const [iface, setIface] = useState(`vmbr${n}`);
  const [cidr, setCidr] = useState("");
  const [ports, setPorts] = useState("");
  const [vlanAware, setVlanAware] = useState(false);
  const [raw, setRaw] = useState(ifaces.find((i) => i.type === "bridge")?.iface ?? "");
  const [vid, setVid] = useState(10);
  const [comments, setComments] = useState("");
  const save = useMutation({
    mutationFn: () => api.networkCreate(node, type === "bridge"
      ? { type, iface, cidr, ports, vlanAware, comments }
      : { type, vlanRaw: raw, vlanId: vid, cidr, comments }),
    onSuccess: onClose,
  });
  return (
    <Modal label={type === "bridge" ? "Nova bridge" : "Nova VLAN"} onClose={onClose}>
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>{type === "bridge" ? "Nova bridge" : "Nova VLAN"}</h2>
      <div className="dialog-sub">{node} · fica pendente até você aplicar</div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          {type === "bridge" ? (
            <>
              <label className="field">Nome<input value={iface} onChange={(e) => setIface(e.target.value)} /></label>
              <label className="field">
                Porta física <small className="muted">(vazio = rede interna)</small>
                <select value={ports} onChange={(e) => setPorts(e.target.value)}>
                  <option value="">nenhuma</option>
                  {ifaces.filter((i) => i.type === "eth" || i.type === "bond").map((i) => <option key={i.iface}>{i.iface}</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field">
                Interface base
                <select value={raw} onChange={(e) => setRaw(e.target.value)}>
                  {ifaces.filter((i) => ["bridge", "eth", "bond"].includes(i.type)).map((i) => <option key={i.iface}>{i.iface}</option>)}
                </select>
              </label>
              <label className="field">Tag (1–4094)<input type="number" min={1} max={4094} value={vid} onChange={(e) => setVid(+e.target.value)} /></label>
            </>
          )}
          <label className="field">IP/prefixo <small className="muted">(opcional)</small><input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.0.30.1/24" /></label>
          <label className="field">Comentário<input value={comments} onChange={(e) => setComments(e.target.value)} /></label>
        </div>
        {type === "bridge" && (
          <label className="check"><input type="checkbox" checked={vlanAware} onChange={(e) => setVlanAware(e.target.checked)} />VLAN aware</label>
        )}
        {save.error && <div className="err">{(save.error as Error).message}</div>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={save.isPending}>Adicionar</button>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

function TailnetField() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (t: string) => api.setTailnet(t), onSuccess: (s) => { qc.setQueryData(["settings"], s); setV(null); } });
  if (!settings?.root) return null;
  const cur = settings.tailscale.tailnet;
  return (
    <form className="ts-row" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); save.mutate(v ?? cur); }}>
      <input value={v ?? cur} onChange={(e) => setV(e.target.value)} placeholder="sua-tailnet.ts.net" aria-label="Domínio da tailnet" />
      <button className="btn small" disabled={v === null || v === cur || save.isPending}>Salvar</button>
      {save.error && <span className="err" style={{ margin: 0 }}>{(save.error as Error).message}</span>}
    </form>
  );
}

function TailscaleCard({ node, bridges }: { node: string; bridges: NetIface[] }) {
  const ui = useUI();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: status } = useStatus();
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [bridge, setBridge] = useState("");
  const [name, setName] = useState("homelab-gw");
  const [err, setErr] = useState("");
  const saveKey = useMutation({
    mutationFn: (k: string) => api.setTailscaleKey(k),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      setKey("");
      setEditing(false);
    },
  });
  const br = bridge || bridges[0]?.iface || "";
  const root = settings?.root;
  const configured = settings?.tailscale.configured;

  const createGateway = async () => {
    setErr("");
    try {
      const r = await api.tailscaleCommand({ action: "gateway", node, bridge: br, hostname: name });
      ui.openConsole({ node, kind: "node", title: "Gateway Tailscale", autorun: r.command });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>VPN · Tailscale</h2>
          <p>Acesse o homelab de qualquer lugar. O host {status?.tailscale ? `está ${status.tailscale}` : "não tem Tailscale"} no momento.</p>
        </div>
      </div>
      <div className="ts-grid">
        <div className="card ts-card">
          <b>1. Auth key</b>
          <p>
            Crie uma chave <b>reutilizável</b> em{" "}
            <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">login.tailscale.com → Keys</a>.
            O Mia usa ela pra colocar o gateway e os apps na sua tailnet.
          </p>
          {!root ? (
            <p className="muted">Só root@pam configura.</p>
          ) : configured && !editing ? (
            <div className="ts-row">
              <span className="mono">{settings?.tailscale.hint}</span>
              <button className="btn small" onClick={() => setEditing(true)}>Trocar</button>
              <button className="btn small danger" onClick={() => saveKey.mutate("")}>Remover</button>
            </div>
          ) : (
            <form className="ts-row" onSubmit={(e) => { e.preventDefault(); saveKey.mutate(key); }}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tskey-auth-…" aria-label="Auth key" />
              <button className="btn small primary" disabled={!key || saveKey.isPending}>Salvar</button>
            </form>
          )}
          {saveKey.error && <div className="err">{(saveKey.error as Error).message}</div>}
        </div>

        <div className="card ts-card">
          <b>2. Gateway pronto</b>
          <p>
            Cria um LXC Debian leve com Tailscale como <i>subnet router</i>: tudo que estiver na rede da bridge fica
            acessível pela VPN, inclusive o que você subir depois.
          </p>
          <div className="ts-row">
            <select value={br} onChange={(e) => setBridge(e.target.value)} aria-label="Bridge">
              {bridges.map((b) => <option key={b.iface} value={b.iface}>{b.iface} · {b.cidr}</option>)}
            </select>
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} aria-label="Nome na tailnet" style={{ maxWidth: 150 }} />
            <button className="btn small primary" disabled={!root || !configured || !br} onClick={createGateway}>Criar gateway</button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Depois aprove a rota no admin do Tailscale (ou use autoApprovers na ACL).</p>
        </div>

        <div className="card ts-card">
          <b>3. Apps com endereço próprio</b>
          <TailnetField />
          <p>
            Na loja de apps marque <i>Publicar no Tailscale</i>, ou abra um contêiner e use <i>Expor no Tailscale</i>.
            Ele ganha <span className="mono">https://nome.sua-tailnet.ts.net</span> com certificado.
          </p>
          <p className="muted" style={{ fontSize: 12 }}>Precisa de HTTPS ligado em DNS no admin do Tailscale.</p>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SpecForm, TaskButton, clean, dt, enc, pve, type Field } from "./Crud";
import { bytes, pct } from "./format";
import { MiniChart } from "./GuestCharts";
import { Modal } from "./Dialogs";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";

const RANGES: [string, string][] = [["hour", "1h"], ["day", "24h"], ["week", "7d"], ["month", "30d"], ["year", "1 ano"]];

type P = Record<string, number>;

export function NodeCharts({ node }: { node: string }) {
  const [tf, setTf] = useState("day");
  const { data } = useQuery({ queryKey: ["node-rrd", node, tf], queryFn: () => pve.get<P[]>(`/nodes/${enc(node)}/rrddata`, { timeframe: tf, cf: "AVERAGE" }), placeholderData: (p) => p });
  const pts = (data ?? []).filter((p) => p.cpu !== undefined);
  const t = pts.map((p) => p.time);
  const long = tf !== "hour";
  return (
    <div className="gcharts" style={{ marginTop: 18 }}>
      <div className="seg">{RANGES.map(([k, l]) => <button key={k} aria-pressed={tf === k} onClick={() => setTf(k)}>{l}</button>)}</div>
      {pts.length > 0 && (
        <div className="node-charts">
          <MiniChart title="CPU" t={t} fmt={pct} max={100} long={long} series={[{ label: "CPU", color: "var(--c-cpu)", values: pts.map((p) => p.cpu * 100) }]} />
          <MiniChart title="Memória" t={t} fmt={bytes} max={pts[0].memtotal} long={long} series={[{ label: "Usada", color: "var(--c-ram)", values: pts.map((p) => p.memused) }]} />
          <MiniChart title="Load" t={t} fmt={(v) => v.toFixed(2)} long={long} series={[{ label: "Load", color: "var(--c-cpu)", values: pts.map((p) => p.loadavg ?? 0) }]} />
          <MiniChart title="Rede" t={t} fmt={(v) => `${bytes(v)}/s`} long={long} series={[
            { label: "Entrada", color: "var(--c-cpu)", values: pts.map((p) => p.netin ?? 0) },
            { label: "Saída", color: "var(--c-ram)", values: pts.map((p) => p.netout ?? 0) }]} />
        </div>
      )}
    </div>
  );
}

// ---------- discos ----------

interface DiskRow { devpath: string; model?: string; type?: string; size: number; health?: string; wearout?: number | string; used?: string; gpt?: number; serial?: string }

export function NodeDisks({ node }: { node: string }) {
  const qc = useQueryClient();
  const n = enc(node);
  const { data: disks } = useQuery({ queryKey: ["disks", node], queryFn: () => pve.get<DiskRow[]>(`/nodes/${n}/disks/list`) });
  const [smart, setSmart] = useState<string | null>(null);
  const [create, setCreate] = useState<"" | "zfs" | "lvm" | "lvmthin" | "directory">("");
  const [upid, setUpid] = useState("");
  const free = (disks ?? []).filter((d) => !d.used || d.used === "unused");
  const refresh = () => { for (const k of ["disks", "zfs-pools", "lvm", "lvmthin", "dirs"]) qc.invalidateQueries({ queryKey: [k, node] }); };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-head">
        <h2>Discos</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn small" onClick={() => setCreate("zfs")}>Criar ZFS</button>
          <button className="btn small" onClick={() => setCreate("lvmthin")}>Criar LVM-thin</button>
          <button className="btn small" onClick={() => setCreate("lvm")}>Criar LVM</button>
          <button className="btn small" onClick={() => setCreate("directory")}>Criar diretório</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Disco</th><th>Modelo</th><th>Tipo</th><th className="num">Tamanho</th><th>Uso</th><th>SMART</th><th>Desgaste</th><th /></tr></thead>
          <tbody>
            {(disks ?? []).map((d) => {
              const wear = typeof d.wearout === "number" && d.type !== "hdd" ? 100 - d.wearout : null;
              return (
                <tr key={d.devpath} style={{ cursor: "default" }}>
                  <td className="mono">{d.devpath}</td>
                  <td>{d.model}</td>
                  <td>{d.type}</td>
                  <td className="num">{bytes(d.size)}</td>
                  <td>{d.used || <span className="muted">livre</span>}</td>
                  <td><span className="status"><span className={`dot ${["PASSED", "OK"].includes((d.health ?? "").toUpperCase()) ? "running" : "hot"}`} />{d.health ?? "—"}</span></td>
                  <td className="mono">{wear !== null ? `${wear}%` : "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn small" onClick={() => setSmart(d.devpath)}>SMART</button>{" "}
                    {(!d.used || d.used === "unused") && !d.gpt && (
                      <TaskButton label="Inicializar GPT" run={() => pve.post(`/nodes/${n}/disks/initgpt`, { disk: d.devpath })} onDone={refresh} />
                    )}{" "}
                    <TaskButton label="Limpar" danger confirm={`Apagar tudo em ${d.devpath}?`} run={() => pve.put(`/nodes/${n}/disks/wipedisk`, { disk: d.devpath })} onDone={refresh} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ZfsPools node={node} />
      {upid && <TaskLog key={upid} upid={upid} onDone={refresh} />}
      {smart && <SmartDialog node={node} disk={smart} onClose={() => setSmart(null)} />}
      {create && (
        <Modal label="Criar armazenamento" onClose={() => setCreate("")} className="wide">
          <button className="close" onClick={() => setCreate("")} aria-label="Fechar"><IconX /></button>
          <h2>{{ zfs: "Criar pool ZFS", lvm: "Criar LVM", lvmthin: "Criar LVM-thin", directory: "Criar diretório" }[create]}</h2>
          <div className="dialog-sub">apaga o que estiver nos discos escolhidos</div>
          <SpecForm
            fields={[
              { key: "name", label: "Nome", required: true, placeholder: create === "zfs" ? "tank" : "dados" },
              ...(create === "zfs"
                ? [
                    { key: "raidlevel", label: "Redundância", type: "select" as const, options: [["single", "Nenhuma (1 disco)"], ["mirror", "Espelho (mirror)"], ["raid10", "RAID10"], ["raidz", "RAIDZ1"], ["raidz2", "RAIDZ2"], ["raidz3", "RAIDZ3"]] as [string, string][] },
                    { key: "compression", label: "Compressão", type: "select" as const, options: [["lz4", "lz4 (recomendado)"], ["zstd", "zstd"], ["on", "on"], ["off", "desligada"]] as [string, string][] },
                    { key: "ashift", label: "ashift", type: "number" as const, help: "12 pra quase todo disco moderno" },
                    { key: "devices", label: "Discos", type: "multi" as const, options: free.map((d) => [d.devpath, `${d.devpath} · ${bytes(d.size)}`] as [string, string]) },
                  ]
                : [
                    { key: "device", label: "Disco", type: "select" as const, options: [["", "Escolha…"], ...free.map((d) => [d.devpath, `${d.devpath} · ${bytes(d.size)}`] as [string, string])] },
                    ...(create === "directory" ? [{ key: "filesystem", label: "Sistema de arquivos", type: "select" as const, options: [["ext4", "ext4"], ["xfs", "xfs"]] as [string, string][] }] : []),
                  ]),
              { key: "add_storage", label: "Já adicionar como storage do Proxmox", type: "checkbox" },
            ] as Field[]}
            initial={{ raidlevel: "mirror", compression: "lz4", ashift: 12, filesystem: "ext4", add_storage: true }}
            submitLabel="Criar"
            onCancel={() => setCreate("")}
            onSubmit={async (v) => {
              const body = clean(v, { joinMulti: " " });
              const r = await pve.post<string>(`/nodes/${n}/disks/${create}`, body);
              setCreate("");
              setUpid(r);
            }}
          />
          {free.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nenhum disco livre. Limpe um disco antes (isso apaga os dados dele).</p>}
        </Modal>
      )}
    </div>
  );
}

function ZfsPools({ node }: { node: string }) {
  const n = enc(node);
  const { data } = useQuery({ queryKey: ["zfs-pools", node], queryFn: () => pve.get<{ name: string; size: number; alloc: number; health: string; frag?: number; dedup?: number }[]>(`/nodes/${n}/disks/zfs`) });
  const [open, setOpen] = useState<string | null>(null);
  const { data: detail } = useQuery({ queryKey: ["zfs", node, open], queryFn: () => pve.get<{ state: string; scan?: string; errors?: string; children?: Vdev[] }>(`/nodes/${n}/disks/zfs/${enc(open!)}`), enabled: !!open });
  if (!data?.length) return null;
  return (
    <>
      <div className="hw-title" style={{ marginTop: 24 }}>Pools ZFS</div>
      <div className="disk-list">
        {data.map((p) => (
          <div key={p.name} className="disk">
            <div className="disk-main">
              <div><b>{p.name}</b><span className="mono muted"> · {p.health}{p.frag !== undefined ? ` · frag ${p.frag}%` : ""}</span></div>
              <div className="bar" style={{ margin: "6px 0 0" }}><i style={{ width: `${(p.alloc / p.size) * 100}%` }} /></div>
            </div>
            <div className="disk-size mono">{bytes(p.alloc)} / {bytes(p.size)}</div>
            <div className="disk-actions"><button className="btn small" onClick={() => setOpen(open === p.name ? null : p.name)}>Detalhes</button></div>
            {open === p.name && detail && (
              <div className="disk-form" style={{ display: "block" }}>
                <p className="mono" style={{ fontSize: 12, margin: "4px 0" }}>{detail.scan}</p>
                <VdevTree nodes={detail.children ?? []} />
                <p className="muted" style={{ fontSize: 12 }}>{detail.errors}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

interface Vdev { name: string; state: string; read?: number; write?: number; cksum?: number; children?: Vdev[] }

function VdevTree({ nodes, depth = 0 }: { nodes: Vdev[]; depth?: number }) {
  return (
    <>
      {nodes.map((v) => (
        <div key={v.name + depth}>
          <div className="mono" style={{ fontSize: 12, paddingLeft: depth * 16 }}>
            <span className={`dot ${v.state === "ONLINE" ? "running" : "hot"}`} style={{ display: "inline-block", marginRight: 6 }} />
            {v.name} · {v.state}{v.read || v.write || v.cksum ? ` · erros ${v.read}/${v.write}/${v.cksum}` : ""}
          </div>
          {v.children && <VdevTree nodes={v.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function SmartDialog({ node, disk, onClose }: { node: string; disk: string; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ["smart", node, disk],
    queryFn: () => pve.get<{ health: string; type: string; text?: string; attributes?: { id: string; name: string; value: number; worst: number; threshold: number; raw: string }[] }>(`/nodes/${enc(node)}/disks/smart`, { disk }),
  });
  return (
    <Modal label="SMART" onClose={onClose} className="wide">
      <button className="close" onClick={onClose} aria-label="Fechar"><IconX /></button>
      <h2>SMART · {disk}</h2>
      <div className="dialog-sub">{data ? `saúde: ${data.health}` : "lendo…"}</div>
      {error && <div className="err">{(error as Error).message}</div>}
      {data?.text && <pre className="diff" style={{ whiteSpace: "pre-wrap" }}>{data.text}</pre>}
      {data?.attributes && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Atributo</th><th className="num">Valor</th><th className="num">Pior</th><th className="num">Limite</th><th className="num">Bruto</th></tr></thead>
            <tbody>
              {data.attributes.map((a) => (
                <tr key={a.id} style={{ cursor: "default" }}>
                  <td className="mono">{a.id}</td><td>{a.name}</td><td className="num">{a.value}</td><td className="num">{a.worst}</td><td className="num">{a.threshold}</td><td className="num">{a.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------- sistema: DNS, hosts, hora, WoL, notas ----------

const TIMEZONES = ["America/Sao_Paulo", "America/Manaus", "America/Fortaleza", "America/Recife", "America/Belem", "America/Cuiaba", "America/Porto_Velho", "America/Rio_Branco", "America/Noronha", "UTC", "Europe/Lisbon", "America/New_York"];

export function NodeSystemTab({ node }: { node: string }) {
  const qc = useQueryClient();
  const n = enc(node);
  const { data: dns } = useQuery({ queryKey: ["dns", node], queryFn: () => pve.get<Record<string, string>>(`/nodes/${n}/dns`) });
  const { data: time } = useQuery({ queryKey: ["time", node], queryFn: () => pve.get<{ timezone: string; localtime: number }>(`/nodes/${n}/time`) });
  const { data: cfg } = useQuery({ queryKey: ["node-config", node], queryFn: () => pve.get<Record<string, string>>(`/nodes/${n}/config`) });
  const { data: hosts } = useQuery({ queryKey: ["hosts", node], queryFn: () => pve.get<{ data: string; digest: string }>(`/nodes/${n}/hosts`) });
  const inval = (k: string) => qc.invalidateQueries({ queryKey: [k, node] });

  return (
    <div style={{ marginTop: 18 }} className="sys-grid">
      <section className="card sys-card">
        <b>DNS</b>
        {dns && (
          <SpecForm key={JSON.stringify(dns)} initial={dns} fields={[
            { key: "search", label: "Domínio de busca", placeholder: "lan" },
            { key: "dns1", label: "Servidor 1", placeholder: "10.0.10.1" },
            { key: "dns2", label: "Servidor 2" },
            { key: "dns3", label: "Servidor 3" },
          ]} onSubmit={async (v) => { await pve.put(`/nodes/${n}/dns`, clean(v)); inval("dns"); }} />
        )}
      </section>
      <section className="card sys-card">
        <b>Hora</b>
        {time && (
          <>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Agora no nó: {new Date(time.localtime * 1000).toLocaleString("pt-BR", { timeZone: "UTC" })}</p>
            <SpecForm key={time.timezone} initial={{ timezone: time.timezone }} fields={[
              { key: "timezone", label: "Fuso horário", type: "select", options: Array.from(new Set([time.timezone, ...TIMEZONES])).map((z) => [z, z]) },
            ]} onSubmit={async (v) => { await pve.put(`/nodes/${n}/time`, v); inval("time"); }} />
          </>
        )}
      </section>
      <section className="card sys-card">
        <b>Wake-on-LAN e notas</b>
        {cfg && (
          <SpecForm key={cfg.digest} initial={cfg} fields={[
            { key: "wakeonlan", label: "MAC pra ligar pela rede", placeholder: "bc:24:11:…", help: "Outro nó do cluster manda o pacote pra ligar este." },
            { key: "description", label: "Notas do nó", type: "textarea" },
          ]} onSubmit={async (v) => { await pve.put(`/nodes/${n}/config`, { wakeonlan: v.wakeonlan, description: v.description, digest: cfg.digest }); inval("node-config"); }} />
        )}
        <div className="sys-actions"><TaskButton label="Mandar Wake-on-LAN pra este nó" run={() => pve.post(`/nodes/${n}/wakeonlan`)} /></div>
      </section>
      <section className="card sys-card span-all">
        <b>/etc/hosts</b>
        {hosts && <HostsEditor key={hosts.digest} node={node} initial={hosts.data} digest={hosts.digest} onSaved={() => inval("hosts")} />}
      </section>
    </div>
  );
}

function HostsEditor({ node, initial, digest, onSaved }: { node: string; initial: string; digest: string; onSaved: () => void }) {
  const [v, setV] = useState(initial);
  const save = useMutation({ mutationFn: () => pve.post(`/nodes/${enc(node)}/hosts`, { data: v, digest }), onSuccess: onSaved });
  return (
    <>
      <textarea className="code" rows={8} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} />
      {save.error && <div className="err">{(save.error as Error).message}</div>}
      <div className="dialog-actions" style={{ marginTop: 8 }}><button className="btn small primary" disabled={v === initial || save.isPending} onClick={() => save.mutate()}>Salvar</button></div>
    </>
  );
}

// ---------- certificados ----------

export function NodeCerts({ node }: { node: string }) {
  const qc = useQueryClient();
  const n = enc(node);
  const { data: certs } = useQuery({ queryKey: ["certs", node], queryFn: () => pve.get<{ filename: string; subject: string; issuer: string; notafter: number; san?: string[]; fingerprint?: string }[]>(`/nodes/${n}/certificates/info`) });
  const { data: cfg } = useQuery({ queryKey: ["node-config", node], queryFn: () => pve.get<Record<string, string>>(`/nodes/${n}/config`) });
  const { data: accounts } = useQuery({ queryKey: ["acme-accounts"], queryFn: () => pve.get<{ name: string }[]>("/cluster/acme/account") });
  const { data: plugins } = useQuery({ queryKey: ["acme-plugins"], queryFn: () => pve.get<{ plugin: string; type: string }[]>("/cluster/acme/plugins") });
  const [upload, setUpload] = useState(false);
  const domains = [0, 1, 2, 3, 4].map((i) => cfg?.[`acmedomain${i}`]).filter(Boolean) as string[];
  const refresh = () => { qc.invalidateQueries({ queryKey: ["certs", node] }); qc.invalidateQueries({ queryKey: ["node-config", node] }); };

  return (
    <div style={{ marginTop: 18 }}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Arquivo</th><th>Para</th><th>Emitido por</th><th>Vence</th></tr></thead>
          <tbody>
            {(certs ?? []).map((c) => (
              <tr key={c.filename} style={{ cursor: "default" }}>
                <td className="mono">{c.filename}</td>
                <td className="mono">{(c.san ?? []).join(", ") || c.subject}</td>
                <td className="mono muted">{c.issuer}</td>
                <td className="mono">{dt(c.notafter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dialog-actions">
        <button className="btn small" onClick={() => setUpload(true)}>Enviar certificado próprio</button>
        <TaskButton label="Voltar pro certificado do Proxmox" confirm="Confirmar: apagar o certificado próprio" danger
          run={() => pve.del(`/nodes/${n}/certificates/custom`, { restart: 1 })} onDone={refresh} />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>A Mia usa o mesmo certificado do Proxmox e recarrega sozinha quando ele muda.</p>

      <div className="hw-title" style={{ marginTop: 24 }}>Let's Encrypt (ACME)</div>
      {!accounts?.length ? (
        <p className="muted" style={{ fontSize: 13 }}>Crie uma conta ACME em Datacenter → ACME antes.</p>
      ) : (
        <>
          <SpecForm key={JSON.stringify(cfg)} initial={{ domain: domains[0]?.match(/domain=([^,]+)/)?.[1] ?? "", plugin: domains[0]?.match(/plugin=([^,]+)/)?.[1] ?? "" }}
            fields={[
              { key: "domain", label: "Domínio", placeholder: "pve.seudominio.com", required: true },
              { key: "plugin", label: "Validação", type: "select", options: [["", "HTTP (porta 80 aberta)"], ...(plugins ?? []).map((p) => [p.plugin, `DNS · ${p.plugin}`] as [string, string])] },
            ]}
            submitLabel="Salvar domínio"
            onSubmit={async (v) => {
              await pve.put(`/nodes/${n}/config`, { acme: `account=${accounts[0].name}`, acmedomain0: `domain=${v.domain}${v.plugin ? `,plugin=${v.plugin}` : ""}` });
              refresh();
            }} />
          {domains.length > 0 && (
            <div className="dialog-actions">
              <TaskButton label="Pedir certificado agora" small={false} run={() => pve.post(`/nodes/${n}/certificates/acme/certificate`, { force: 1 })} onDone={refresh} />
              <TaskButton label="Renovar" small={false} run={() => pve.put(`/nodes/${n}/certificates/acme/certificate`, { force: 1 })} onDone={refresh} />
            </div>
          )}
        </>
      )}
      {upload && (
        <Modal label="Certificado próprio" onClose={() => setUpload(false)} className="wide">
          <button className="close" onClick={() => setUpload(false)} aria-label="Fechar"><IconX /></button>
          <h2>Enviar certificado próprio</h2>
          <SpecForm fields={[
            { key: "certificates", label: "Certificado (PEM, com a cadeia)", type: "textarea", required: true, placeholder: "-----BEGIN CERTIFICATE-----" },
            { key: "key", label: "Chave privada (PEM)", type: "textarea", required: true, placeholder: "-----BEGIN PRIVATE KEY-----" },
          ]} onCancel={() => setUpload(false)} onSubmit={async (v) => {
            await pve.post(`/nodes/${n}/certificates/custom`, { ...v, restart: 1, force: 1 });
            setUpload(false);
            refresh();
          }} />
        </Modal>
      )}
    </div>
  );
}

// ---------- log ----------

export function NodeLog({ node }: { node: string }) {
  const [kind, setKind] = useState<"journal" | "firewall">("journal");
  const [filter, setFilter] = useState("");
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["node-log", node, kind],
    queryFn: async () => kind === "journal"
      ? pve.get<string[]>(`/nodes/${enc(node)}/journal`, { lastentries: 500 })
      : (await pve.get<{ n: number; t: string }[]>(`/nodes/${enc(node)}/firewall/log`, { limit: 500 })).map((l) => l.t),
    refetchInterval: 15_000,
  });
  const lines = (data ?? []).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div style={{ marginTop: 18 }}>
      <div className="filters" style={{ marginTop: 0 }}>
        <div className="seg" style={{ paddingTop: 0 }}>
          <button aria-pressed={kind === "journal"} onClick={() => setKind("journal")}>Sistema</button>
          <button aria-pressed={kind === "firewall"} onClick={() => setKind("firewall")}>Firewall</button>
        </div>
        <input placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar log" />
        <button className="btn small" onClick={() => refetch()} disabled={isFetching}>Atualizar</button>
      </div>
      <pre className="logbox">{lines.join("\n") || "Nada."}</pre>
    </div>
  );
}

// ---------- assinatura ----------

export function NodeSubscription({ node }: { node: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["subscription", node], queryFn: () => pve.get<{ status: string; message?: string; productname?: string; nextduedate?: string; level?: string }>(`/nodes/${enc(node)}/subscription`) });
  return (
    <div style={{ marginTop: 18 }}>
      {data && (
        <dl className="kv">
          <dt>Status</dt><dd>{data.status}</dd>
          {data.productname && <><dt>Produto</dt><dd>{data.productname}</dd></>}
          {data.nextduedate && <><dt>Vence</dt><dd>{data.nextduedate}</dd></>}
          {data.message && <><dt>Mensagem</dt><dd>{data.message}</dd></>}
        </dl>
      )}
      <p className="muted" style={{ fontSize: 13 }}>Sem assinatura o Proxmox funciona normal; use o repositório no-subscription (aba Repositórios).</p>
      <SpecForm fields={[{ key: "key", label: "Chave de assinatura", placeholder: "pve4c-…", required: true }]} submitLabel="Ativar"
        onSubmit={async (v) => { await pve.put(`/nodes/${enc(node)}/subscription`, v); qc.invalidateQueries({ queryKey: ["subscription", node] }); }} />
    </div>
  );
}

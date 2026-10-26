import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { health, kindLabel } from "./format";
import {
  IconApps, IconDownload, IconHome, IconLXC, IconLogout, IconNetwork, IconNodes, IconSearch, IconShield, IconSidebar,
  IconStorage, IconTerminal, IconVM,
} from "./icons";
import { MiaMark } from "./Logo";
import { Link, usePath } from "./router";
import { useFavorites, useGuests, useMe, useStatus, useUI } from "./state";
import { UpdateNotice } from "./Update";

export const NAV = [
  { path: "/", label: "Visão geral", icon: IconHome },
  { path: "/nos", label: "Nós", icon: IconNodes },
  { path: "/vms", label: "Máquinas virtuais", icon: IconVM },
  { path: "/lxc", label: "Contêineres LXC", icon: IconLXC },
  { path: "/apps", label: "Apps", icon: IconApps },
  { path: "/armazenamento", label: "Armazenamento", icon: IconStorage },
  { path: "/rede", label: "Rede", icon: IconNetwork },
  { path: "/backups", label: "Backups", icon: IconShield },
  { path: "/console", label: "Console", icon: IconTerminal },
];

export function Sidebar({ onToggle }: { onToggle: () => void }) {
  const path = usePath();
  const ui = useUI();
  const { data: status } = useStatus();
  const { data: guests } = useGuests();
  const { data: me } = useMe();
  const favs = useFavorites(guests);
  const qc = useQueryClient();

  const c = status?.cluster;
  const logout = async () => {
    await api.logout().catch(() => {});
    qc.clear();
    location.reload();
  };

  return (
    <aside className="side" aria-label="Navegação">
      <div className="brand">
        <div className="brand-logo">
          <MiaMark width={20} height={19} />
        </div>
        <div className="brand-text">
          <div className="brand-name">Mia</div>
          <div className="brand-sub">{c ? `${c.name} · ${c.nodes} ${c.nodes === 1 ? "nó" : "nós"}` : "…"}</div>
        </div>
        <button className="icon-btn" onClick={onToggle} aria-label="Recolher menu"><IconSidebar /></button>
      </div>

      <button className="side-search" onClick={() => ui.setSearchOpen(true)}>
        <IconSearch width={16} height={16} />
        <span>Buscar VM, LXC, nó…</span>
        <kbd>/</kbd>
      </button>

      <nav className="nav">
        {NAV.map(({ path: p, label, icon: Icon }) => (
          <Link key={p} to={p} aria-current={path === p ? "page" : undefined} title={label}>
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>

      <div className="side-label">FAVORITOS</div>
      <div className="favs">
        {favs.list.map((g) => (
          <button key={g.id} className="fav" onClick={() => ui.openGuest(g.id)} title={g.name}>
            <span className={`dot ${health(g)}`} />
            <span className="name">{g.name}</span>
            <span className="mono">{kindLabel(g)} {g.vmid}</span>
          </button>
        ))}
        {guests && !favs.list.length && <div className="fav-empty">Marque guests com ☆ pra fixar aqui.</div>}
      </div>

      <dl className="side-foot">
        <dt>Quórum</dt>
        <dd className={c ? (c.quorate ? "good" : "bad") : ""}>
          {c ? (c.standalone ? "nó único" : `${c.quorate ? "OK" : "SEM"} · ${c.nodesOnline}/${c.nodes}`) : "…"}
        </dd>
        <dt>Proxmox VE</dt>
        <dd>{c?.pveVersion || "…"}</dd>
        {status?.tailscale && (
          <>
            <dt>Tailscale</dt>
            <dd className={status.tailscale === "online" ? "" : "bad"}>{status.tailscale}</dd>
          </>
        )}
        <UpdateNotice icon={<IconDownload width={14} height={14} />} />
        <div className="side-user">
          <span title={me?.user}>{me?.user}</span>
          <button onClick={logout} aria-label="Sair" title="Sair"><IconLogout width={16} height={16} /></button>
        </div>
      </dl>
    </aside>
  );
}

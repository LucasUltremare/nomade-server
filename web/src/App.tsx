import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, setUnauthorizedHandler } from "./api";
import { AppsPage } from "./Apps";
import { ConsoleModal, ConsolePage } from "./Console";
import { BackupDialog, GuestDialog, SearchPalette } from "./Dialogs";
import { NetworkPage } from "./Network";
import { NewLxcDialog } from "./NewLxc";
import { StoragePage } from "./Storage";
import { IconBell, IconCalendar, IconSidebar } from "./icons";
import { Login } from "./Login";
import { NodePanel } from "./NodePanel";
import { GuestsPage, NodesPage, OverviewPage, SoonPage } from "./Pages";
import { usePath } from "./router";
import { NAV, Sidebar } from "./Sidebar";
import { UIProvider, useMe, useUI } from "./state";

export function App() {
  const qc = useQueryClient();
  const { data: me, error, isLoading } = useMe();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      qc.setQueryData(["me"], undefined);
      qc.invalidateQueries({ queryKey: ["me"] });
    });
  }, [qc]);

  if (isLoading) return <div className="splash">mia</div>;
  if (!me || (error instanceof ApiError && error.status === 401)) return <Login />;
  return (
    <UIProvider>
      <Shell />
    </UIProvider>
  );
}

const TABS = ["Recursos", "Saúde", "Backups", "Firewall", "Tarefas"];

function Shell() {
  const path = usePath();
  const ui = useUI();
  const [collapsed, setCollapsed] = useState(() => localGet("mia.collapsed") === "1");
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState("Recursos");
  const now = useClock();

  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        ui.setSearchOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        ui.setBackupOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui]);

  const toggle = () => {
    setCollapsed((c) => {
      localSet("mia.collapsed", c ? "0" : "1");
      return !c;
    });
  };

  const current = NAV.find((n) => n.path === path) ?? NAV[0];
  const withPanel = path === "/" || path === "/nos";

  let page;
  switch (path) {
    case "/":
      page = tab === "Recursos" ? <OverviewPage /> : <SoonPage title={tab} what={TAB_SOON[tab]} />;
      break;
    case "/nos": page = <NodesPage />; break;
    case "/vms": page = <GuestsPage type="qemu" />; break;
    case "/lxc": page = <GuestsPage type="lxc" />; break;
    case "/apps": page = <AppsPage />; break;
    case "/armazenamento": page = <StoragePage />; break;
    case "/rede": page = <NetworkPage />; break;
    case "/backups": page = <SoonPage title="Backups" what="Jobs agendados e histórico do vzdump. Os arquivos de backup e a restauração já estão em Armazenamento." />; break;
    case "/console": page = <ConsolePage />; break;
    default: page = <SoonPage title="Não encontrado" what="Essa página não existe." />;
  }

  return (
    <div className={`app ${collapsed ? "collapsed" : ""} ${withPanel ? "" : "no-panel"} ${drawer ? "drawer" : ""}`}>
      <Sidebar onToggle={toggle} />
      {drawer && <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setDrawer(false)} />}
      <main className="main">
        <header className="topbar">
          <button className="chip-btn square menu-btn" onClick={() => setDrawer(true)} aria-label="Abrir menu">
            <IconSidebar width={16} height={16} />
          </button>
          <div className="crumbs">Datacenter<i>/</i><b>{current.label}</b></div>
          {path === "/" && (
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
              ))}
            </div>
          )}
          <div className="top-actions" style={path === "/" ? undefined : { marginLeft: "auto" }}>
            <span className="chip-btn date"><IconCalendar width={15} height={15} />{now}</span>
            <button className="chip-btn square" aria-label="Notificações" title="Notificações (em breve)">
              <IconBell width={16} height={16} />
            </button>
          </div>
        </header>
        {page}
      </main>
      {withPanel && <NodePanel />}
      <GuestDialog />
      <BackupDialog />
      <SearchPalette />
      <NewLxcDialog />
      <ConsoleModal />
    </div>
  );
}

const TAB_SOON: Record<string, string> = {
  Saúde: "Alertas de disco, SMART, ZFS, serviços do PVE e atualizações pendentes.",
  Backups: "Última execução de cada guest, falhas e guests sem backup.",
  Firewall: "Regras do datacenter, dos nós e dos guests.",
  Tarefas: "Tudo que está rodando ou rodou no cluster, com log.",
};

function useClock() {
  const fmt = () => {
    const d = new Date();
    const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `${date} · ${time}`;
  };
  const [v, setV] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setV(fmt()), 15_000);
    return () => clearInterval(id);
  }, []);
  return v;
}

function localGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function localSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* modo privado */
  }
}

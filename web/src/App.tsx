import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, setUnauthorizedHandler } from "./api";
import { AppsPage } from "./Apps";
import { BackupsPage } from "./Backups";
import { FirewallPage } from "./Firewall";
import { HealthPage } from "./Health";
import { Notifications } from "./Notifications";
import { TasksPage } from "./Tasks";
import { ConsoleModal, ConsolePage } from "./Console";
import { BackupDialog, GuestDialog, SearchPalette } from "./Dialogs";
import { NetworkPage } from "./Network";
import { NewLxcDialog } from "./NewLxc";
import { NewVmDialog } from "./NewVm";
import { MyAppsPage } from "./MyApps";
import { NodePage } from "./NodePage";
import { StoragePage } from "./Storage";
import { IconCalendar, IconSidebar } from "./icons";
import { Login } from "./Login";
import { NodePanel } from "./NodePanel";
import { GuestsPage, NodesPage, OverviewPage, SoonPage } from "./Pages";
import { navigate, usePath } from "./router";
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

  const current = NAV.find((n) => n.path === path) ?? NAV.find((n) => n !== NAV[0] && path.startsWith(n.path + "/")) ?? NAV[0];
  const withPanel = (path === "/" && tab === "Recursos") || path === "/nos";

  let page;
  switch (path) {
    case "/":
      page = {
        Recursos: <OverviewPage />, Saúde: <HealthPage />, Backups: <BackupsPage />, Firewall: <FirewallPage />, Tarefas: <TasksPage />,
      }[tab] ?? <OverviewPage />;
      break;
    case "/nos": page = <NodesPage />; break;
    case "/meus-apps": page = <MyAppsPage />; break;
    case "/vms": page = <GuestsPage type="qemu" />; break;
    case "/lxc": page = <GuestsPage type="lxc" />; break;
    case "/apps": page = <AppsPage />; break;
    case "/armazenamento": page = <StoragePage />; break;
    case "/rede": page = <NetworkPage />; break;
    case "/backups": page = <BackupsPage />; break;
    case "/console": page = <ConsolePage />; break;
    default:
      page = path.startsWith("/nos/")
        ? <NodePage key={path} name={decodeURIComponent(path.slice(5))} />
        : <SoonPage title="Não encontrado" what="Essa página não existe." />;
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
            <Notifications onOpen={(t) => { navigate("/"); setTab(t); }} />
          </div>
        </header>
        {page}
      </main>
      {withPanel && <NodePanel />}
      <GuestDialog />
      <BackupDialog />
      <SearchPalette />
      <NewLxcDialog />
      <NewVmDialog />
      <ConsoleModal />
    </div>
  );
}


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

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Guest, type Range } from "./api";
import type { ConsoleTarget } from "./Terminal";

// Estado de interface compartilhado: nó em foco, diálogos abertos.
interface UI {
  node: string | null;
  setNode: (n: string) => void;
  guestId: string | null;
  openGuest: (id: string | null) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  backupOpen: boolean;
  setBackupOpen: (v: boolean) => void;
  range: Range;
  setRange: (r: Range) => void;
  /**
   * Consoles abertos. Fechar a janela só minimiza: a sessão (e o que estiver
   * rodando nela, tipo a instalação de um app) continua até encerrar.
   */
  consoles: ConsoleSession[];
  activeConsole: string | null;
  openConsole: (t: ConsoleTarget) => void;
  showConsole: (id: string | null) => void;
  closeConsole: (id: string) => void;
  setConsoleStatus: (id: string, status: ConsoleSession["status"]) => void;
  /** Área da página Console: com ela, os consoles aparecem embutidos ali em vez de em janela. */
  consoleSlot: HTMLElement | null;
  setConsoleSlot: (el: HTMLElement | null) => void;
  /** Diálogo de novo LXC; o valor é o nó sugerido. */
  newLxc: string | null;
  setNewLxc: (node: string | null) => void;
  newVm: string | null;
  setNewVm: (node: string | null) => void;
}

export interface ConsoleSession {
  id: string;
  target: ConsoleTarget;
  status: "connecting" | "connected" | "closed" | "error";
}

const Ctx = createContext<UI | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<string | null>(null);
  const [guestId, openGuest] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [range, setRange] = useState<Range>("24h");
  const [consoles, setConsoles] = useState<ConsoleSession[]>([]);
  const [activeConsole, showConsole] = useState<string | null>(null);
  const openConsole = useCallback((target: ConsoleTarget) => {
    const id = Math.random().toString(36).slice(2);
    setConsoles((c) => [...c, { id, target, status: "connecting" }]);
    showConsole(id);
  }, []);
  const closeConsole = useCallback((id: string) => {
    setConsoles((c) => {
      const i = c.findIndex((x) => x.id === id);
      const rest = c.filter((x) => x.id !== id);
      // Encerrar a aba aberta passa pra vizinha; a janela só some sem sessões.
      showConsole((a) => (a === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : a));
      return rest;
    });
  }, []);
  const setConsoleStatus = useCallback((id: string, status: ConsoleSession["status"]) => {
    setConsoles((c) => c.map((x) => (x.id === id && x.status !== status ? { ...x, status } : x)));
  }, []);
  const [consoleSlot, setConsoleSlot] = useState<HTMLElement | null>(null);
  const [newLxc, setNewLxc] = useState<string | null>(null);
  const [newVm, setNewVm] = useState<string | null>(null);
  const value = useMemo(
    () => ({
      node, setNode, guestId, openGuest, searchOpen, setSearchOpen, backupOpen, setBackupOpen, range, setRange,
      consoles, activeConsole, openConsole, showConsole, closeConsole, setConsoleStatus, consoleSlot, setConsoleSlot,
      newLxc, setNewLxc, newVm, setNewVm,
    }),
    [node, guestId, searchOpen, backupOpen, range, consoles, activeConsole, openConsole, closeConsole, setConsoleStatus, consoleSlot, newLxc, newVm],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUI fora do UIProvider");
  return v;
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: api.me, retry: false, staleTime: Infinity });

export function useOverview() {
  const { range } = useUI();
  return useQuery({
    queryKey: ["overview", range],
    queryFn: () => api.overview(range),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
}

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });

export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 15_000 });

/** Lista de guests sempre fresca, compartilhada pelas telas de lista e busca. */
export const useGuests = () =>
  useQuery({ queryKey: ["guests"], queryFn: api.guests, refetchInterval: 10_000 });

/**
 * Favoritos do usuário. Quem nunca escolheu vê os 5 guests rodando com mais
 * RAM alocada (estável, ao contrário de "mais CPU agora").
 */
export function useFavorites(guests: Guest[] | undefined) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const chosen = me?.favorites;

  const ids = useMemo(() => {
    if (chosen) return chosen;
    return [...(guests ?? [])]
      .filter((g) => g.status === "running" && !g.template)
      .sort((a, b) => b.maxmem - a.maxmem || a.vmid - b.vmid)
      .slice(0, 5)
      .map((g) => g.id);
  }, [chosen, guests]);

  const save = useMutation({
    mutationFn: api.setFavorites,
    onSuccess: (r) => qc.setQueryData(["me"], { ...me!, favorites: r.favorites }),
  });

  const toggle = useCallback(
    (id: string) => save.mutate(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
    [ids, save],
  );

  const list = useMemo(() => {
    const byId = new Map((guests ?? []).map((g) => [g.id, g]));
    return ids.map((id) => byId.get(id)).filter((g): g is Guest => !!g);
  }, [ids, guests]);

  return { ids, list, toggle };
}

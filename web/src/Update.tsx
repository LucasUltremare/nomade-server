import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Aviso de versão nova. Com o mia-update.path instalado (instalador ≥ v0.2),
 * root@pam atualiza com um clique: o Mia grava um arquivo que o systemd
 * observa e roda o instalador como root.
 */
export function UpdateNotice({ icon }: { icon: ReactNode }) {
  const { data } = useQuery({ queryKey: ["update"], queryFn: api.updateInfo, staleTime: 60 * 60_000, retry: false });
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [err, setErr] = useState("");
  if (!data?.available) return null;

  const run = async () => {
    setState("running");
    try {
      await api.runUpdate();
      // O serviço reinicia no meio; espera a versão mudar e recarrega.
      const start = Date.now();
      const poll = async () => {
        try {
          const m = await api.meta();
          if (m.version !== data.current) return location.reload();
        } catch {
          /* reiniciando */
        }
        if (Date.now() - start > 180_000) {
          setState("error");
          setErr("demorou demais; veja journalctl -u mia-update");
          return;
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 4000);
    } catch (e) {
      setState("error");
      setErr((e as Error).message);
    }
  };

  return (
    <div className="update">
      <div className="update-head">{icon}<b>Mia {data.latest}</b><span>disponível</span></div>
      {data.selfUpdate ? (
        <button onClick={run} disabled={state === "running"}>{state === "running" ? "Atualizando…" : "Atualizar agora"}</button>
      ) : (
        <span className="update-hint">Rode o comando de instalação de novo no shell do Proxmox.</span>
      )}
      {data.url && <a href={data.url} target="_blank" rel="noreferrer">o que mudou</a>}
      {state === "error" && <span className="update-err">{err}</span>}
    </div>
  );
}

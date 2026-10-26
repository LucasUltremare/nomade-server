import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

const INSTALL = `bash -c "$(curl -fsSL https://raw.githubusercontent.com/LucasUltremare/nomade-server/main/install.sh)"`;

/**
 * Aviso de versão nova. Só avisa: atualizar é no shell do Proxmox, rodando o
 * instalador e escolhendo "Atualizar". O painel não atualiza sozinho.
 */
export function UpdateNotice({ icon }: { icon: ReactNode }) {
  const { data } = useQuery({ queryKey: ["update"], queryFn: api.updateInfo, staleTime: 60 * 60_000, retry: false });
  const [copied, setCopied] = useState(false);
  if (!data?.available) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* sem clipboard: o comando está no README */
    }
  };

  return (
    <div className="update">
      <div className="update-head">{icon}<b>Mia {data.latest}</b><span>disponível</span></div>
      <span className="update-hint">No shell do Proxmox, rode o instalador e escolha Atualizar.</span>
      <button onClick={copy}>{copied ? "Copiado" : "Copiar comando"}</button>
      {data.url && <a href={data.url} target="_blank" rel="noreferrer">o que mudou</a>}
    </div>
  );
}

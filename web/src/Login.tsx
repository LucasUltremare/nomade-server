import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export function Login() {
  const qc = useQueryClient();
  const { data: realms } = useQuery({ queryKey: ["realms"], queryFn: api.realms, retry: false });
  const { data: meta } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [realm, setRealm] = useState("pam");
  const [tfa, setTfa] = useState(false);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState("totp");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const done = () => qc.invalidateQueries({ queryKey: ["me"] });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (tfa) {
        await api.tfa(code, kind);
        await done();
      } else {
        const r = await api.login(username, password, realm);
        if (r.needTfa) setTfa(true);
        else await done();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art">
        <div className="brand-name" style={{ fontSize: 20 }}>Mia</div>
        <h1>Seu Proxmox, num painel que dá gosto de abrir.</h1>
        <span className="mono">nomade · {meta?.version ?? ""}</span>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <h2>{tfa ? "Segundo fator" : "Entrar"}</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            {tfa ? "Digite o código do seu app autenticador." : "Use a mesma conta do Proxmox VE."}
          </p>

          {tfa ? (
            <>
              <label className="field">
                Código
                <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric"
                  autoComplete="one-time-code" />
              </label>
              <label className="field">
                Tipo
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="totp">TOTP (app autenticador)</option>
                  <option value="recovery">Código de recuperação</option>
                  <option value="yubico">Yubico OTP</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field">
                Usuário
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
              </label>
              <label className="field">
                Senha
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
              <label className="field">
                Realm
                <select value={realm} onChange={(e) => setRealm(e.target.value)}>
                  {(realms ?? [{ realm: "pam", comment: "Linux PAM" }]).map((r) => (
                    <option key={r.realm} value={r.realm}>{r.comment || r.realm} ({r.realm})</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {err && <div className="err">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? "Entrando…" : tfa ? "Confirmar" : "Entrar"}</button>
          {tfa && (
            <button type="button" className="btn" onClick={() => { setTfa(false); setCode(""); }} style={{ marginTop: 8 }}>
              Voltar
            </button>
          )}
          {meta?.demo && (
            <div className="demo-hint">
              Modo demo: qualquer usuário e senha entram. Usuário começando com <b>tfa</b> pede código (123456).
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

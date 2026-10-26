import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { Modal } from "./Dialogs";
import { IconX } from "./icons";
import { TaskLog } from "./Tasks";

// Chamadas pras rotas espelho do Mia (/api/pve/<caminho do Proxmox>).
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/pve${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Mia": "1" },
    body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const qs = (q?: Record<string, string | number | undefined>) => {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const pve = {
  get: <T,>(path: string, q?: Record<string, string | number | undefined>) => call<T>("GET", path + qs(q)),
  post: <T,>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  del: <T,>(path: string, q?: Record<string, string | number | undefined>) => call<T>("DELETE", path + qs(q)),
};

export const enc = encodeURIComponent;

// ---------- formulário por especificação ----------

export type Value = string | number | boolean | string[];
export type Values = Record<string, Value>;

export interface Field {
  key: string;
  label: string;
  type?: "text" | "number" | "password" | "select" | "checkbox" | "textarea" | "multi";
  options?: [string, string][];
  placeholder?: string;
  help?: string;
  required?: boolean;
  wide?: boolean;
  /** Só aparece quando a condição bate com os valores atuais. */
  show?: (v: Values) => boolean;
  /** Não editável depois de criado (ex.: o ID). */
  fixed?: boolean;
}

export function SpecForm({ fields, initial, editing, submitLabel, onSubmit, onCancel, extra }: {
  fields: Field[];
  initial?: Values;
  editing?: boolean;
  submitLabel?: string;
  onSubmit: (v: Values) => Promise<unknown>;
  onCancel?: () => void;
  extra?: (v: Values, set: (k: string, x: Value) => void) => ReactNode;
}) {
  const [v, setV] = useState<Values>(() => {
    const out: Values = {};
    for (const f of fields) out[f.key] = initial?.[f.key] ?? (f.type === "checkbox" ? false : f.type === "multi" ? [] : "");
    return { ...initial, ...out };
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: Value) => setV((o) => ({ ...o, [k]: x }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    for (const f of fields) {
      if (f.required && (f.show?.(v) ?? true) && (v[f.key] === "" || v[f.key] === undefined)) {
        return setErr(`Preencha "${f.label}".`);
      }
    }
    // Campo escondido não vai pro PVE (ex.: opção que só existe em outro tipo de storage).
    const out = { ...v };
    for (const f of fields) if (f.show && !f.show(v)) delete out[f.key];
    setBusy(true);
    try {
      await onSubmit(out);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        {fields.filter((f) => f.show?.(v) ?? true).map((f) => {
          const disabled = editing && f.fixed;
          if (f.type === "checkbox") {
            return (
              <label key={f.key} className="check span2">
                <input type="checkbox" checked={!!v[f.key]} disabled={disabled} onChange={(e) => set(f.key, e.target.checked)} />
                {f.label}{f.help && <small> · {f.help}</small>}
              </label>
            );
          }
          if (f.type === "multi") {
            const cur = (v[f.key] as string[]) ?? [];
            return (
              <div key={f.key} className="field span2">
                {f.label}
                <div className="chip-picks">
                  {f.options?.map(([val, lab]) => (
                    <label key={val} className={`pick ${cur.includes(val) ? "on" : ""}`}>
                      <input type="checkbox" checked={cur.includes(val)} disabled={disabled}
                        onChange={() => set(f.key, cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val])} />
                      {lab}
                    </label>
                  ))}
                </div>
                {f.help && <small className="muted">{f.help}</small>}
              </div>
            );
          }
          return (
            <label key={f.key} className={`field ${f.wide || f.type === "textarea" ? "span2" : ""}`}>
              {f.label}{f.required && " *"}
              {f.type === "select" ? (
                <select value={String(v[f.key] ?? "")} disabled={disabled} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options?.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea rows={4} value={String(v[f.key] ?? "")} disabled={disabled} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"} value={String(v[f.key] ?? "")}
                  disabled={disabled} placeholder={f.placeholder} autoComplete={f.type === "password" ? "new-password" : "off"}
                  onChange={(e) => set(f.key, f.type === "number" ? (e.target.value === "" ? "" : +e.target.value) : e.target.value)} />
              )}
              {f.help && <small className="muted">{f.help}</small>}
            </label>
          );
        })}
      </div>
      {extra?.(v, set)}
      {err && <div className="err">{err}</div>}
      <div className="dialog-actions">
        <button className="btn primary" disabled={busy}>{busy ? "Salvando…" : submitLabel ?? "Salvar"}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancelar</button>}
      </div>
    </form>
  );
}

/** Tira campos vazios e converte listas, pra mandar pro PVE. */
export function clean(v: Record<string, unknown>, opts?: { joinMulti?: string; keep?: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (Array.isArray(x)) {
      if (x.length || opts?.keep?.includes(k)) out[k] = opts?.joinMulti !== undefined ? x.join(opts.joinMulti) : x;
    } else if (x !== "" && x !== undefined && x !== null) {
      out[k] = x;
    } else if (opts?.keep?.includes(k)) {
      out[k] = x;
    }
  }
  return out;
}

// ---------- lista com criar/editar/apagar ----------

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
  mono?: boolean;
}

export function CrudSection<T extends Record<string, unknown>>({
  title, help, queryKey, list, columns, idOf, fields, create, update, remove, toForm, rowActions, empty, createLabel, headerExtra,
}: {
  title: string;
  help?: ReactNode;
  queryKey: unknown[];
  list: () => Promise<T[]>;
  columns: Column<T>[];
  idOf: (row: T) => string;
  fields?: Field[] | ((editing: T | null) => Field[]);
  create?: (v: Values) => Promise<unknown>;
  update?: (row: T, v: Values) => Promise<unknown>;
  remove?: (row: T) => Promise<unknown>;
  toForm?: (row: T) => Values;
  rowActions?: (row: T, refresh: () => void) => ReactNode;
  empty?: string;
  createLabel?: string;
  headerExtra?: ReactNode;
}) {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey, queryFn: list });
  const [editing, setEditing] = useState<T | "new" | null>(null);
  const [confirm, setConfirm] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey });
  const del = useMutation({ mutationFn: (row: T) => remove!(row), onSuccess: () => { setConfirm(""); refresh(); } });
  const fieldList = typeof fields === "function" ? fields(editing === "new" ? null : editing) : fields ?? [];

  return (
    <section className="crud">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {help && <p>{help}</p>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {headerExtra}
          {create && <button className="btn small primary" onClick={() => setEditing("new")}>{createLabel ?? "Adicionar"}</button>}
        </div>
      </div>
      {isLoading && <p className="muted">Carregando…</p>}
      {error && <div className="err">{(error as Error).message}</div>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead><tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}<th /></tr></thead>
            <tbody>
              {data.map((row) => {
                const id = idOf(row);
                return (
                  <tr key={id} style={{ cursor: "default" }}>
                    {columns.map((c) => <td key={c.label} className={c.mono ? "mono" : ""}>{c.render(row)}</td>)}
                    <td className="row-actions">
                      <div>
                        {rowActions?.(row, refresh)}
                        {update && <button className="btn small" onClick={() => setEditing(row)}>Editar</button>}
                        {remove && (confirm === id
                          ? <button className="btn small danger" onClick={() => del.mutate(row)}>Confirmar</button>
                          : <button className="btn small" onClick={() => setConfirm(id)}>Apagar</button>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!data.length && <tr><td colSpan={columns.length + 1} className="muted">{empty ?? "Nada aqui."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {del.error && <div className="err">{(del.error as Error).message}</div>}
      {editing && (
        <Modal label={title} onClose={() => setEditing(null)} className="wide">
          <button className="close" onClick={() => setEditing(null)} aria-label="Fechar"><IconX /></button>
          <h2>{editing === "new" ? (createLabel ?? "Adicionar") : `Editar ${idOf(editing)}`}</h2>
          <SpecForm
            fields={fieldList}
            editing={editing !== "new"}
            initial={editing === "new" ? undefined : toForm?.(editing) ?? (editing as unknown as Values)}
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              if (editing === "new") await create!(v);
              else await update!(editing, v);
              setEditing(null);
              refresh();
            }}
          />
        </Modal>
      )}
    </section>
  );
}

/** Botão que dispara uma task do PVE e mostra o log. */
export function TaskButton({ label, run, confirm, danger, onDone, small = true }: {
  label: string;
  run: () => Promise<unknown>;
  confirm?: string;
  danger?: boolean;
  onDone?: () => void;
  small?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [upid, setUpid] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    setErr("");
    setArmed(false);
    try {
      const r = await run();
      if (typeof r === "string" && r.startsWith("UPID:")) setUpid(r);
      else onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <button className={`btn ${small ? "small" : ""} ${danger ? "danger" : ""} ${armed ? "primary" : ""}`}
        onClick={() => (confirm && !armed ? setArmed(true) : go())}>
        {armed ? confirm : label}
      </button>
      {err && <div className="err">{err}</div>}
      {upid && <div className="task-inline"><TaskLog key={upid} upid={upid} onDone={onDone} /></div>}
    </>
  );
}

export const yes = (x: unknown) => x === 1 || x === "1" || x === true;
export const dt = (ts?: unknown) => (ts ? new Date(Number(ts) * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

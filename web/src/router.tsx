// Roteador mínimo em cima da History API; o backend devolve o index.html em
// qualquer rota fora de /api e /assets.
import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export const usePath = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

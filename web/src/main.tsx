import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { ApiError } from "./api";
import { App } from "./App";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      // 401/403 não melhoram tentando de novo.
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

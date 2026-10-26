import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Em dev, o Vite faz proxy da API pro `mia serve --demo` (ou pra um Mia real).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.MIA_API ?? "https://127.0.0.1:8443", secure: false, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: false, assetsDir: "assets" },
});

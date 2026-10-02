import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies the API to a hub on :8080 (see ../README.md, "Local dev").
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5178, proxy: { "/api": "http://localhost:8080" } },
  // Not dist/: the repo root .gitignore drops every dist/, and the Go embed needs
  // static/.keep committed so the hub compiles before the panel is built.
  build: { outDir: "static", emptyOutDir: true },
});

import { defineConfig } from "vite";

// The window's source is ui/; the built files go to dist/, which Tauri embeds
// (src-tauri/tauri.conf.json, build.frontendDist).
export default defineConfig({
  root: "ui",
  clearScreen: false,
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
});

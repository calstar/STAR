import { defineConfig } from "@playwright/test";

// The window against the real backend and simulated board: the harness
// (examples/serve.rs) runs the backend behind a WebSocket, Vite serves ui/,
// and each page load gets a fresh board (?ws= tells the page where to connect).
// Both listen on ::1: on WSL a connect to a closed 127.0.0.1 port hangs for two
// minutes instead of being refused, and Playwright probes the ports first.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: "http://[::1]:5178", viewport: { width: 1280, height: 860 } },
  webServer: [
    { command: "cargo run --quiet --example serve -- --port 5179", url: "http://[::1]:5179", timeout: 600_000, reuseExistingServer: false },
    { command: "npx vite --host ::1", url: "http://[::1]:5178", timeout: 60_000, reuseExistingServer: false },
  ],
});

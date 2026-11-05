#!/usr/bin/env node
// The app the browser tests (e2e/, `npm run e2e`) run against: a throwaway
// Postgres, every committed migration, the demo seed, then the app on :3100.
//
// The database is the `embedded-postgres` package (a real Postgres 16, like
// production and `npm run dev:local`), in a fresh temp directory that is
// deleted on exit, so every run starts from the same seeded state and CI needs
// no database service. It never touches .localdb/ or your dev database.
//
//   E2E_BUILT=1  serve the production build (`next start`; run `npm run build`
//                first) -- what CI does. Otherwise `next dev`, for writing tests.
//
// Playwright starts and stops this itself (playwright.config.ts `webServer`).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "starproject-e2e-db-"));
const DB_PORT = Number(process.env.E2E_DB_PORT ?? 54339);
const APP_PORT = process.env.E2E_PORT ?? "3100";
const DATABASE_URL = `postgresql://starproject:starproject@localhost:${DB_PORT}/starproject?schema=public`;

const env = {
  ...process.env,
  DATABASE_URL,
  // The seed makes this address an admin and a PVP. The app itself gets no
  // DEV_AUTH_* fallback: the browser sends X-Auth-Email like Caddy does in
  // production (playwright.config.ts), so a test exercises the real seam.
  DEV_AUTH_EMAIL: process.env.E2E_EMAIL ?? "e2e@berkeley.edu",
  DEV_AUTH_NAME: "E2E Admin",
  // Never send mail (mail.ts no-ops without it).
  SES_FROM: "",
};
const appEnv = { ...env };
delete appEnv.DEV_AUTH_EMAIL;
delete appEnv.DEV_AUTH_NAME;

const run = (cmd, args, e = env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env: e, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "starproject",
  password: "starproject",
  port: DB_PORT,
  persistent: false,
  onLog: () => {},
});

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await pg.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("starproject");
  await run("npx", ["prisma", "migrate", "deploy"]);
  await run("node", ["scripts/seed-local.mjs"]);
  const next = process.env.E2E_BUILT ? ["next", "start"] : ["next", "dev"];
  await run("npx", [...next, "-p", APP_PORT], appEnv);
  await stop(0);
} catch (err) {
  console.error(err.message);
  await stop(1);
}

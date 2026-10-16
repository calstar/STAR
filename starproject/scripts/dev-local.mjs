#!/usr/bin/env node
// A whole STARProject on this machine, with no Docker and no system Postgres:
//
//   npm run dev:local            start a private Postgres, migrate, seed demo data, run `next dev`
//   npm run dev:local -- --reset wipe the local database first and start over
//   npm run dev:local -- --db    just the database (for `prisma migrate dev`), Ctrl-C to stop
//
// The Postgres is the `embedded-postgres` package (a real Postgres 16, the
// version production runs), kept in .localdb/ and listening on 54329 so it
// never collides with a Postgres you run yourself. Migrations go through
// `prisma migrate deploy`, the command the production container runs, so a
// migration that would fail on deploy fails here first. Nothing here can
// reach production: the database URL is always localhost.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".localdb");
const PORT = Number(process.env.LOCAL_DB_PORT ?? 54329);
const DB = "starproject";
const args = new Set(process.argv.slice(2));

const LOCAL_DATABASE_URL = `postgresql://starproject:starproject@localhost:${PORT}/${DB}?schema=public`;

const env = {
  ...process.env,
  DATABASE_URL: LOCAL_DATABASE_URL,
  // Who you are in the local app (Caddy's header in production). The seed
  // makes this address an admin so approving BOM lines can be tried.
  DEV_AUTH_EMAIL: process.env.DEV_AUTH_EMAIL ?? "dev@berkeley.edu",
  DEV_AUTH_NAME: process.env.DEV_AUTH_NAME ?? "Dev User",
  // Never send mail from a local run (mail.ts no-ops without it).
  SES_FROM: "",
};

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited ${code}`))));
  });
}

/** Is something already listening on the database port? (A local Postgres a
 * previous run left behind, e.g. when its terminal was closed.) */
const portInUse = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
const leftOver = await portInUse();
if (leftOver && args.has("--reset")) {
  console.error(`Something is still running on :${PORT}. Stop it first (pkill -f "postgres -D ${dataDir}") and run --reset again.`);
  process.exit(1);
}

if (args.has("--reset") && existsSync(dataDir)) {
  console.log("Wiping .localdb/ …");
  rmSync(dataDir, { recursive: true, force: true });
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "starproject",
  password: "starproject",
  port: PORT,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(dataDir);
if (leftOver) {
  console.log(`Reusing the local Postgres already running on :${PORT}.`);
} else {
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(DB);
  console.log(`Local Postgres on :${PORT} (${fresh ? "new" : "existing"} data in .localdb/)`);
}

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (!leftOver) await pg.stop().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  if (args.has("--db")) {
    console.log(`DATABASE_URL=${LOCAL_DATABASE_URL}`);
    console.log("Database only. Ctrl-C to stop.");
    await new Promise(() => {});
  }

  await run("npx", ["prisma", "migrate", "deploy"]);
  await run("node", ["scripts/seed-local.mjs"]);
  console.log(`\nYou are ${env.DEV_AUTH_NAME} <${env.DEV_AUTH_EMAIL}> (an admin). Open http://localhost:3000\n`);
  await run("npx", ["next", "dev", "-p", process.env.PORT ?? "3000"]);
  await stop(0);
} catch (err) {
  console.error(err.message);
  await stop(1);
}

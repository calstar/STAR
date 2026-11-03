import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API, API_PORT, UI_PORT } from './e2e/stack';

/**
 * End-to-end for the cockpit, on a stack this config boots itself:
 *   - the FastAPI backend on API_PORT, over a library and a user-data root made
 *     fresh for this run, with the design tools pointed at a port nobody
 *     listens on (the suite never imports from a developer's EngineDesign or
 *     pid-designer);
 *   - Vite on UI_PORT, proxying /api to that backend (vite.config.ts follows
 *     FEED_TWIN_API_PORT).
 *
 * Never reuses a server. The demo path spec removes everything from the
 * library it is pointed at, and a reused server would be somebody's real one;
 * a port already taken fails the run instead.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const stamp = `${process.pid}-${Date.now()}`;
const FEEDTWIN_LIBRARY = path.join(os.tmpdir(), `feedtwin-e2e-library-${stamp}`);
const USERDATA_DIR = path.join(os.tmpdir(), `feedtwin-e2e-userdata-${stamp}`);

// CI installs the backend into the runner's python; a checkout set up by
// dev.sh/setup.sh has it in feed-twin/.venv. FEEDTWIN_PYTHON overrides both.
const venv = path.join(appRoot, '.venv', 'bin', 'python3');
const PYTHON = process.env.FEEDTWIN_PYTHON ?? (fs.existsSync(venv) ? venv : 'python');

// An x86_64 node on Apple silicon runs under Rosetta and starts its children
// as x86_64 too; a universal python then loads its x86_64 half and cannot
// import the venv's arm64 wheels. Ask for the machine's own architecture.
function underRosetta(): boolean {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return false;
  try {
    return execSync('sysctl -n sysctl.proc_translated', { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false;
  }
}
const NATIVE = underRosetta() ? 'arch -arm64 ' : '';

// Nothing listens on the discard port: an import asks and fails at once.
const NOWHERE = 'http://127.0.0.1:9';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  // A whole burn, from an empty library: open the stand, T-0, FIRE, burnout.
  // The burn runs in slow motion on a stiff stand (CLAUDE.md, "The console
  // runs the study's numerics"), and a CI core is slower than a laptop's.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    viewport: { width: 1920, height: 1080 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } }],
  webServer: [
    {
      command: `${NATIVE}"${PYTHON}" -m uvicorn backend.main:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: appRoot,
      url: `${API}/api/health`,
      env: {
        FEEDTWIN_LIBRARY,
        USERDATA_DIR,
        ENGINE_DESIGN_URL: NOWHERE,
        PID_DESIGNER_URL: NOWHERE,
      },
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // IPv4 explicitly: vite's "localhost" can resolve to ::1 on a runner
      // while Playwright polls 127.0.0.1, and the server never looks ready.
      command: `npm run dev -- --host 127.0.0.1 --port ${UI_PORT} --strictPort`,
      cwd: here,
      url: `http://127.0.0.1:${UI_PORT}`,
      env: { FEED_TWIN_API_PORT: String(API_PORT) },
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

/**
 * Starts/stops the DAQ data pipeline for a session run, gated by a 3-state mode
 * read from SESSION_SERVICE_MODE:
 *   off     (default) — inert. The launch-site laptop (start_tmux_dev.sh) never
 *                       sets it, so nothing here is ever controlled and no run
 *                       can be auto-stopped mid-launch.
 *   mock    — logs instead of shelling systemctl (developer testing on a laptop).
 *   systemd — real `systemctl --user` on the always-on apps box.
 *
 * Only the always-on server's sensor-backend.service sets SESSION_SERVICE_MODE=systemd.
 */
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// daq-server repo root (…/daq-server), from …/daq-server/diablo_server/backend/{src,dist}.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SIM_SCRIPT = join(PROJECT_ROOT, 'sim', 'board_simulator.py');
const SIM_CONFIG = join(PROJECT_ROOT, 'config', 'sim_config.toml');
// The frozen canonical config the sim overlay derives from (committed; tests use it too).
const CONFIG_BASE = join(PROJECT_ROOT, 'config', 'config_base.toml');

/**
 * Generate the loopback sim overlay (config/sim_config.toml) from config_base.toml — the same
 * 192.168.2.x → 127.0.0.x remap start_systemd_sim.sh does. Done here so a simulated run works on
 * ANY box (a hardware server never runs start_systemd_sim.sh, so the file would otherwise be missing
 * and the simulated pipeline would point at a nonexistent config and fail). Regenerated each sim
 * start so it tracks config_base.
 */
function ensureSimConfig(): void {
  if (!existsSync(CONFIG_BASE)) {
    throw new Error(`Cannot start a simulated run: ${CONFIG_BASE} is missing (it is committed — is the checkout complete?)`);
  }
  writeFileSync(SIM_CONFIG, readFileSync(CONFIG_BASE, 'utf-8').replace(/192\.168\.2\./g, '127.0.0.'));
}

export type SessionServiceMode = 'off' | 'mock' | 'systemd';

export function getSessionServiceMode(): SessionServiceMode {
  const raw = (process.env.SESSION_SERVICE_MODE || 'off').toLowerCase();
  return raw === 'systemd' ? 'systemd' : raw === 'mock' ? 'mock' : 'off';
}

// The data pipeline a run cycles. The web layer (sensor-backend/frontend) stays up.
// sensor-simulator is added when USE_SIM=1 (synthetic data instead of hardware).
const BASE_UNITS = [
  'sensor-elodin',
  'sensor-daq',
  'sensor-calibration',
  'sensor-controller',
  'sensor-actuator',
];

function pipelineUnits(simulated: boolean): string[] {
  const units = [...BASE_UNITS];
  if (simulated) units.push('sensor-simulator');
  return units;
}

// The elodin unit reads its per-run DB dir from this EnvironmentFile (systemd mode).
const SESSION_ENV_PATH = join(homedir(), '.config', 'daq', 'session.env');
// Optional data-source overlay the pipeline units already read: a simulated run
// sets USE_SIM=1 + the IP-remapped sim config; a live run points back at hardware.
const PIPELINE_ENV_PATH = join(homedir(), '.config', 'daq', 'pipeline.env');

function runSystemctl(action: 'start' | 'stop', units: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('systemctl', ['--user', action, ...units], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`systemctl ${action} exited ${code}`)),
    );
  });
}

/** Per-unit state via `systemctl is-active` (one line per unit). Never rejects. */
function systemctlStates(units: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('systemctl', ['--user', 'is-active', ...units], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve(units.map(() => 'unknown')));
    proc.on('exit', () => resolve(out.trim().split('\n').map((s) => s.trim())));
  });
}

// A run's UDP sockets (esp. daq_bridge:5006) are only freed once its unit's process
// exits. Starting the next run before teardown finishes makes the new daq_bridge
// collide and crash-loop → no data. Treat only these as "settled": active/activating/
// deactivating mean a process may still hold the port.
const SETTLED_STATES = new Set(['inactive', 'failed', 'unknown', '']);

async function waitUntilSettled(units: string[], timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await systemctlStates(units);
    if (states.every((s) => SETTLED_STATES.has(s))) return true;
    if (Date.now() >= deadline) {
      console.warn(`[Session] teardown not settled in ${timeoutMs}ms; units: ${states.join(',')}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Poll until every unit reports `active`; bail early (false) on a hard `failed`
 *  (e.g. AssertPathExists tripped by a missing elodin-db), or on timeout. */
async function waitUntilActive(units: string[], timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await systemctlStates(units);
    if (states.every((s) => s === 'active')) return true;
    if (states.some((s) => s === 'failed')) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export class ServiceController {
  constructor(private readonly mode: SessionServiceMode) {}

  /** Mock-mode simulator child (systemd manages the sensor-simulator unit instead). */
  private simProc: ChildProcess | null = null;

  async start(dbDir: string, simulated = false): Promise<void> {
    if (this.mode === 'systemd') {
      // A simulated run reads config/sim_config.toml (loopback overlay). Generate it here so sim
      // works on ANY box — a hardware server never runs start_systemd_sim.sh, so it'd be missing.
      if (simulated) ensureSimConfig();
      mkdirSync(dirname(SESSION_ENV_PATH), { recursive: true });
      writeFileSync(SESSION_ENV_PATH, `ELODIN_DB_DIR=${dbDir}\n`);
      // Per-run data-source overlay consumed by the pipeline units.
      writeFileSync(
        PIPELINE_ENV_PATH,
        simulated
          ? 'USE_SIM=1\nDAQ_CONFIG=config/sim_config.toml\n'
          : 'USE_SIM=0\nDAQ_CONFIG=config/config.toml\n',
      );
      // Never start onto a not-yet-torn-down previous run — a lingering daq_bridge
      // still owns :5006 and the new one would crash-loop. Wait for a clean slate.
      await waitUntilSettled(pipelineUnits(true));
      await runSystemctl('start', pipelineUnits(simulated));
      // A run isn't real unless the DB actually came up. If elodin-db is missing/broken,
      // sensor-elodin hard-fails (AssertPathExists) or crash-loops — without this check the
      // session would report "active" and later claim the run was "saved" with no data.
      if (!(await waitUntilActive(['sensor-elodin'], 10000))) {
        await runSystemctl('stop', pipelineUnits(true)).catch(() => {});
        throw new Error(
          'Pipeline failed to start: sensor-elodin (elodin-db) did not become active. ' +
          'Is elodin-db installed at ~/.cargo/bin/elodin-db? See deploy/bootstrap_daq.sh.',
        );
      }
    } else {
      console.log(`[Session] (mock) start pipeline → ${dbDir} (simulated=${simulated})`);
      // In mock mode the pipeline is already running; only the simulator is ours
      // to start/stop for the run.
      if (simulated) this.spawnSimulator();
    }
  }

  async stop(): Promise<void> {
    if (this.mode === 'systemd') {
      // Stop the superset (incl. the simulator) so no data source lingers between runs.
      await runSystemctl('stop', pipelineUnits(true));
      // Confirm every process actually exited (sockets freed) before we report done,
      // so a subsequent start() sees a clean slate.
      await waitUntilSettled(pipelineUnits(true));
    } else {
      console.log('[Session] (mock) stop pipeline');
      this.stopSimulator();
    }
  }

  /** Re-assert the simulator after a backend restart recovered an active simulated run. */
  async resume(simulated: boolean): Promise<void> {
    if (!simulated) return;
    if (this.mode === 'systemd') {
      await runSystemctl('start', ['sensor-simulator']);
    } else {
      this.spawnSimulator();
    }
  }

  private spawnSimulator(): void {
    if (this.simProc && !this.simProc.killed) return; // already running
    const args = [SIM_SCRIPT, '--config', SIM_CONFIG, '--target', '127.0.0.1', '--port', '5006'];
    const proc = spawn('python3', args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    proc.on('error', (err) => console.error('[Session] board simulator failed to start:', err));
    proc.on('exit', (code) => {
      console.log(`[Session] board simulator exited (${code})`);
      if (this.simProc === proc) this.simProc = null;
    });
    this.simProc = proc;
    console.log(`[Session] board simulator started (pid ${proc.pid})`);
  }

  private stopSimulator(): void {
    if (!this.simProc) return;
    console.log(`[Session] stopping board simulator (pid ${this.simProc.pid})`);
    this.simProc.kill('SIGTERM');
    this.simProc = null;
  }
}

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
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

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

function pipelineUnits(): string[] {
  const units = [...BASE_UNITS];
  if (process.env.USE_SIM === '1') units.push('sensor-simulator');
  return units;
}

// The elodin unit reads its per-run DB dir from this EnvironmentFile (systemd mode).
const SESSION_ENV_PATH = join(homedir(), '.config', 'daq', 'session.env');

function runSystemctl(action: 'start' | 'stop', units: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('systemctl', ['--user', action, ...units], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`systemctl ${action} exited ${code}`)),
    );
  });
}

export class ServiceController {
  constructor(private readonly mode: SessionServiceMode) {}

  async start(dbDir: string): Promise<void> {
    if (this.mode === 'systemd') {
      mkdirSync(dirname(SESSION_ENV_PATH), { recursive: true });
      writeFileSync(SESSION_ENV_PATH, `ELODIN_DB_DIR=${dbDir}\n`);
      await runSystemctl('start', pipelineUnits());
    } else {
      console.log(`[Session] (mock) start pipeline → ${dbDir} :: ${pipelineUnits().join(', ')}`);
    }
  }

  async stop(): Promise<void> {
    if (this.mode === 'systemd') {
      await runSystemctl('stop', pipelineUnits());
    } else {
      console.log(`[Session] (mock) stop pipeline :: ${pipelineUnits().join(', ')}`);
    }
  }
}

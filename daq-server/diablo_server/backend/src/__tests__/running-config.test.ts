/**
 * The running config: what the backend (and every display page, via /api/config/running) reads
 * must be the file the pipeline reads.
 *
 * A simulated run's C++ services read the sim overlay generated from config_base.toml, not
 * config.toml. The backend used to read config.toml regardless, so the GUI showed a different
 * stand from the one running: ball valve board 71, enabled only in the sim config, never appeared
 * on Sensor Info in the Playwright stack.
 *
 * Hermetic: CONFIG_PATH points at a temp directory, and the pipeline launcher is stubbed (it would
 * otherwise spawn the simulator and regenerate sim_config.toml under the real project root).
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-running-'));
const configDir = join(root, 'config');
mkdirSync(join(configDir, 'profiles', 'default'), { recursive: true });
const DEPLOYED = join(configDir, 'config.toml');
const SIM = join(configDir, 'sim_config.toml');

const board = (key: string, id: number) =>
  `[boards.${key}]\ntype = "PT"\nboard_id = ${id}\nip = "192.0.2.${id}"\nenabled = true\nactive_connectors = [ 1 ]\n`;
writeFileSync(DEPLOYED, board('deployed_board', 1));
writeFileSync(SIM, board('sim_board', 2));
writeFileSync(join(configDir, 'profiles', 'default', 'config.toml'), board('deployed_board', 1));

process.env.CONFIG_PATH = DEPLOYED;
process.env.SESSION_SERVICE_MODE = 'mock';
process.env.SESSION_STATE_PATH = join(root, 'session.json');
delete process.env.RUNNING_CONFIG_PATH;

vi.mock('../service-controller.js', () => ({
  getSessionServiceMode: () => 'mock',
  ServiceController: class {
    async start() {}
    async stop() {}
    async resume() {}
    // What the real one answers in systemd mode: the sim overlay for a simulated run.
    pipelineConfigPath(simulated: boolean) {
      return simulated ? SIM : null;
    }
  },
}));

const cfg = await import('../routes/config.js');
const { sessionManager } = await import('../session-manager.js');

const boardKeys = (c: any) => Object.keys(c?.boards ?? {});

afterEach(() => {
  cfg.setRunningConfigPath(null);
  delete process.env.RUNNING_CONFIG_PATH;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('running config', () => {
  it('is config.toml when nothing says otherwise', () => {
    expect(cfg.getRunningConfigPath()).toBe(DEPLOYED);
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['deployed_board']);
    expect(boardKeys(cfg.readConfig())).toEqual(['deployed_board']);
  });

  it('follows RUNNING_CONFIG_PATH (a stack started on the sim config)', () => {
    process.env.RUNNING_CONFIG_PATH = SIM;
    expect(cfg.getRunningConfigPath()).toBe(SIM);
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['sim_board']);
    expect(boardKeys(cfg.readConfig())).toEqual(['sim_board']);
  });

  it('moving it drops the cached config, and writes still go to config.toml', () => {
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['deployed_board']);
    cfg.setRunningConfigPath(SIM);
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['sim_board']);
    cfg.writeConfig({ boards: { written: { type: 'PT', board_id: 3 } } });
    expect(readFileSync(DEPLOYED, 'utf-8')).toContain('written');
    expect(readFileSync(SIM, 'utf-8')).not.toContain('written');
    writeFileSync(DEPLOYED, board('deployed_board', 1));
  });
});

describe('a simulated session', () => {
  it('reads the sim overlay for the run, config.toml again after, and announces both moves', async () => {
    let announced = 0;
    sessionManager.init(() => {}, () => {}, () => {}, () => { announced++; }, () => {});

    await sessionManager.start(false, 60_000, true);
    expect(cfg.getRunningConfigPath()).toBe(SIM);
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['sim_board']);
    expect(announced).toBe(1);

    await sessionManager.stop();
    expect(cfg.getRunningConfigPath()).toBe(DEPLOYED);
    expect(boardKeys(cfg.readDeployedConfig())).toEqual(['deployed_board']);
    expect(announced).toBe(2);
  });

  it('a live session leaves it on config.toml', async () => {
    let announced = 0;
    sessionManager.init(() => {}, () => {}, () => {}, () => { announced++; }, () => {});
    await sessionManager.start(false, 60_000, false, true);
    expect(cfg.getRunningConfigPath()).toBe(DEPLOYED);
    await sessionManager.stop();
    expect(cfg.getRunningConfigPath()).toBe(DEPLOYED);
    // Only the deploy at live start announced; no running-config move did.
    expect(announced).toBe(1);
  });
});

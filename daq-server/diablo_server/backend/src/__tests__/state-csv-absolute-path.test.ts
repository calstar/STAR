/**
 * C5-4: the state-CSV loaders join `[state_machine]` paths onto fixed roots, so an absolute
 * `transitions_csv` / `actuator_csv` (what the lifecycle harness writes, and what an operator may
 * write) was never found and the loaders fell back to config/*.csv, or found nothing. They now take
 * an absolute path as written. The CSVs here live in a temp directory no fallback root can reach,
 * and the assertions name the file each loader read.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, copyFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config', 'profiles', 'default');
const dir = mkdtempSync(join(tmpdir(), 'state-csv-abs-'));
const transitionsCsv = join(dir, 'my_transitions.csv');
const actuatorsCsv = join(dir, 'my_actuators.csv');
copyFileSync(join(PROFILE, 'state_transitions.csv'), transitionsCsv);
copyFileSync(join(PROFILE, 'state_machine_actuators.csv'), actuatorsCsv);

const config = { state_machine: { transitions_csv: transitionsCsv, actuator_csv: actuatorsCsv } };
vi.mock('../routes/config.js', () => ({ readConfig: () => config, readDeployedConfig: () => config }));

const { getStateTransitions } = await import('../state-csv/state-transitions.js');
const { getStateActuatorMap } = await import('../state-csv/state-actuators.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function loggedLines(fn: () => unknown): string[] {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
}

describe('absolute [state_machine] paths', () => {
  it('getStateTransitions reads transitions_csv from the absolute path', () => {
    let transitions: unknown[] = [];
    const lines = loggedLines(() => { transitions = getStateTransitions(); });
    expect(lines).toContain(`✅ Loaded state transitions from: ${transitionsCsv}`);
    expect(transitions.length).toBeGreaterThan(0);
  });

  it('getStateActuatorMap reads actuator_csv from the absolute path', () => {
    let map: object = {};
    const lines = loggedLines(() => { map = getStateActuatorMap(); });
    expect(lines).toContain(`✅ Loaded state actuator map from: ${actuatorsCsv}`);
    expect(Object.keys(map).length).toBeGreaterThan(0);
  });
});

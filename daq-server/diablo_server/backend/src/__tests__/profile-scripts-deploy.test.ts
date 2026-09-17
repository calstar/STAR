/**
 * Dynamic-state scripts deploy with their profile.
 *
 * A profile is a directory that owns its state-machine CSVs, and deploying copies the whole thing
 * out to config/. Scripts joined that set, and the failure if they had not is nastier than it
 * looks: config.toml and the CSVs would land while the script a `[[states]]` entry names did not,
 * so the sequencer would refuse a state the operator had just watched save successfully — and it
 * would read as a sequencer bug rather than a deploy bug.
 *
 * deployActiveProfile's own contract is all-or-nothing ("a half-applied deploy is worse than no
 * deploy"), so the rollback case is tested too: a config that does not parse must leave the
 * previously-deployed script exactly as it was.
 *
 * Hermetic: CONFIG_PATH points at a temp directory, which is what every config-profiles path
 * resolves from, so nothing here touches the real config.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'daq-scripts-'));
const configDir = join(root, 'config');
const profileDir = join(configDir, 'profiles', 'default');
mkdirSync(profileDir, { recursive: true });
process.env.CONFIG_PATH = join(configDir, 'config.toml');

const profiles = await import('../routes/config-profiles.js');

const GOOD_CONFIG = `
[network]
actuator_cmd_port = 5005

[[states]]
id = 1
name = "Idle"
is_boot = true

[[states]]
id = 2
name = "COPV Press"
script_file = "copv_press.script"
script_timeout_ms = 30000
script_return_target = "Idle"
script_timeout_target = "Idle"
`;

const SCRIPT = `target = 0.9 * pressure(GN2_HIGH)
while pressure(GN2_REGULATED) < target:
    open_valve(GSE_HIGH_PRESS_CONTROL)
    delay(0.2)
    close_valve(GSE_HIGH_PRESS_CONTROL)
    delay(0.2)
transition_to(IDLE)
`;

const deployedScript = join(configDir, 'scripts', 'copv_press.script');
const profileScript = join(profileDir, 'scripts', 'copv_press.script');

function seedProfile(config = GOOD_CONFIG, script: string | null = SCRIPT): void {
  writeFileSync(join(profileDir, 'config.toml'), config, 'utf-8');
  writeFileSync(join(profileDir, 'state_transitions.csv'), ',Idle\nIdle,1\n', 'utf-8');
  writeFileSync(join(profileDir, 'state_machine_actuators.csv'), ',Idle\nVent,CLOSE\n', 'utf-8');
  rmSync(join(profileDir, 'scripts'), { recursive: true, force: true });
  if (script !== null) {
    mkdirSync(join(profileDir, 'scripts'), { recursive: true });
    writeFileSync(profileScript, script, 'utf-8');
  }
}

beforeEach(() => {
  rmSync(join(configDir, 'scripts'), { recursive: true, force: true });
  rmSync(join(configDir, 'config.toml'), { force: true });
  writeFileSync(join(configDir, '.active_profile'), 'default\n', 'utf-8');
  seedProfile();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('profile deploy carries dynamic-state scripts', () => {
  it('copies scripts/ alongside config.toml and the CSVs', () => {
    profiles.deployActiveProfile();
    expect(existsSync(deployedScript)).toBe(true);
    expect(readFileSync(deployedScript, 'utf-8')).toBe(SCRIPT);
  });

  it('creates config/scripts/ when it does not already exist', () => {
    expect(existsSync(join(configDir, 'scripts'))).toBe(false);
    profiles.deployActiveProfile();
    expect(existsSync(join(configDir, 'scripts'))).toBe(true);
  });

  it('redeploys an edited script', () => {
    profiles.deployActiveProfile();
    writeFileSync(profileScript, 'delay(1)\n', 'utf-8');
    profiles.deployActiveProfile();
    expect(readFileSync(deployedScript, 'utf-8')).toBe('delay(1)\n');
  });

  it('lists an undeployed script edit as a pending change', () => {
    profiles.deployActiveProfile();
    expect(profiles.undeployedChanges()).toEqual([]);
    writeFileSync(profileScript, 'delay(2)\n', 'utf-8');
    expect(profiles.undeployedChanges()).toContain('scripts/copv_press.script');
  });

  it('rolls the script back when the config does not parse', () => {
    profiles.deployActiveProfile();
    expect(readFileSync(deployedScript, 'utf-8')).toBe(SCRIPT);

    // A profile that will fail the post-copy parse, with a different script beside it.
    seedProfile('this is not = = valid toml [[[', 'delay(99)\n');
    expect(() => profiles.deployActiveProfile()).toThrow();

    // All-or-nothing: the previously deployed script must be untouched, not the new one.
    expect(readFileSync(deployedScript, 'utf-8')).toBe(SCRIPT);
  });

  it('a profile with no scripts/ directory deploys normally', () => {
    seedProfile(GOOD_CONFIG, null);
    expect(() => profiles.deployActiveProfile()).not.toThrow();
    expect(existsSync(join(configDir, 'config.toml'))).toBe(true);
  });

  it('a new profile created from another inherits its scripts', () => {
    profiles.createProfile('copy-of-default', 'default');
    const copied = join(configDir, 'profiles', 'copy-of-default', 'scripts', 'copv_press.script');
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf-8')).toBe(SCRIPT);
  });

  it('does not deploy stray non-script files from scripts/', () => {
    writeFileSync(join(profileDir, 'scripts', 'copv_press.script.bak'), 'junk\n', 'utf-8');
    profiles.deployActiveProfile();
    expect(existsSync(join(configDir, 'scripts', 'copv_press.script.bak'))).toBe(false);
  });
});

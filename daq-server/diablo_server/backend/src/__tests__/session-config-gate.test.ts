/**
 * The config gate on session start.
 *
 * Config problems used to be advisory: the editor drew them in red, and an operator could start a
 * run on exactly that config anyway. The gate is what changed that, and this is the test that says
 * so — in particular that a refused start leaves NOTHING behind. Session start is where the active
 * profile is copied into config/config.toml and the C++ services read it, so a gate that refuses
 * but still deploys, or still marks the session active, would be worse than no gate at all.
 *
 * Hermetic: CONFIG_PATH points at a temp directory, which is what every config-profiles path
 * resolves from (getConfigDir → dirname(getConfigPath)), so nothing here touches the real config.
 * SESSION_SERVICE_MODE=mock makes ServiceController a no-op, so start() runs its whole real path —
 * gate, deploy, persist — without systemd.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The pipeline launcher is stubbed out entirely. Even in 'mock' mode the real one spawns a python3
// board simulator and regenerates config/sim_config.toml under the REAL project root — side
// effects outside this test's temp dir, for a class that is not what is under test here. What IS
// under test is SessionManager's gate, which runs before any of it.
vi.mock('../service-controller.js', () => ({
  getSessionServiceMode: () => 'mock',
  ServiceController: class {
    async start() {}
    async stop() {}
    async resume() {}
  },
}));

const root = mkdtempSync(join(tmpdir(), 'daq-gate-'));
const configDir = join(root, 'config');
const profileDir = join(configDir, 'profiles', 'default');
mkdirSync(profileDir, { recursive: true });

process.env.CONFIG_PATH = join(configDir, 'config.toml');
process.env.SESSION_SERVICE_MODE = 'mock';
// Keep runs out of the real ~/.local/share/elodin.
process.env.SESSION_STATE_PATH = join(root, 'session.json');

const CLEAN_PROFILE = `
[boards.act_board]
type = "ACTUATOR"
board_id = 12
ip = "192.0.2.12"
enabled = true

[actuator_roles]
"Fuel Press" = ["NC", 3, 12, "pwm_fuel"]
"LOX Press" = ["NO", 8, 12, "pwm_ox"]

[fire]
state = "Fire"
expiry_target = "Armed"

[[states]]
id = 1
name = "Idle"

[[states]]
id = 2
name = "Armed"
is_abort = true

[[states]]
id = 3
name = "Fire"
`;

const ACTUATORS_CSV = ',Idle,Armed,Fire\nFuel Press,CLOSE,CLOSE,OPEN\nLOX Press,CLOSE,CLOSE,OPEN\n';
const DELAYS_CSV = ',Idle,Armed,Fire\nFuel Press,0,0,0\nLOX Press,0,0,0\n';
const TRANSITIONS_CSV = ',Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1,1\nFire,0,1,1\n';

/** Write a profile (and its CSVs) as the active one, and reset what is deployed. */
function writeProfile(configToml: string): void {
  writeFileSync(join(profileDir, 'config.toml'), configToml);
  writeFileSync(join(profileDir, 'state_machine_actuators.csv'), ACTUATORS_CSV);
  writeFileSync(join(profileDir, 'state_machine_actuator_delays.csv'), DELAYS_CSV);
  writeFileSync(join(profileDir, 'state_transitions.csv'), TRANSITIONS_CSV);
  writeFileSync(join(configDir, '.active_profile'), 'default');
  // A deployed config that is recognisably NOT the profile, so "did the gate deploy?" is decidable.
  writeFileSync(process.env.CONFIG_PATH!, '# deployed-marker\n');
}

const deployed = () => readFileSync(process.env.CONFIG_PATH!, 'utf-8');

const { sessionManager } = await import('../session-manager.js');
const { ConfigIssuesError, validateActiveProfile } = await import('../config-validation.js');

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  if (sessionManager.getStatus().active) await sessionManager.stop();
  vi.restoreAllMocks();
});

describe('the gate lets a clean profile through', () => {
  it('starts, and deploys the profile it validated', async () => {
    writeProfile(CLEAN_PROFILE);
    expect(validateActiveProfile().issues).toEqual([]);

    await sessionManager.start(false, 60_000);
    expect(sessionManager.getStatus().active).toBe(true);
    expect(deployed()).toContain('Fuel Press');   // the profile actually reached config.toml
    await sessionManager.stop();
  });
});

describe('the gate refuses a broken profile', () => {
  // A duplicate state id: the later entry wins and the earlier state silently disappears.
  const BROKEN = CLEAN_PROFILE.replace('id = 3\nname = "Fire"', 'id = 1\nname = "Fire"');

  it('throws ConfigIssuesError naming the page that fixes it', async () => {
    writeProfile(BROKEN);
    await expect(sessionManager.start(false, 60_000)).rejects.toThrow(ConfigIssuesError);

    const { issues, profile } = validateActiveProfile();
    expect(profile).toBe('default');
    expect(issues.some((i) => i.page === 'state' && i.level === 'error')).toBe(true);
  });

  it('starts nothing and deploys nothing — the run must not half-happen', async () => {
    writeProfile(BROKEN);
    await expect(sessionManager.start(false, 60_000)).rejects.toThrow(ConfigIssuesError);

    const status = sessionManager.getStatus();
    expect(status.active).toBe(false);
    // dbDir is the tell for a start that mutated state before refusing: the session page would
    // show a run store path for a run that never began.
    expect(status.dbDir).toBeNull();
    expect(status.deadlineMs).toBeNull();
    expect(deployed()).toBe('# deployed-marker\n');
  });

  it('runs anyway on force — the operator overruling it with the list in front of them', async () => {
    writeProfile(BROKEN);
    await expect(sessionManager.start(false, 60_000)).rejects.toThrow(ConfigIssuesError);

    await sessionManager.start(false, 60_000, false, true);
    expect(sessionManager.getStatus().active).toBe(true);
    expect(deployed()).toContain('Fuel Press');
    await sessionManager.stop();
  });

  it('blocks on warnings too, not just errors', async () => {
    // "No state is flagged Abort" is a warning. It still stops the first press: an operator who
    // wanted it would not have configured it that way, and one press to look is cheap.
    writeProfile(CLEAN_PROFILE.replace('is_abort = true\n', ''));
    const { issues } = validateActiveProfile();
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warn');
    await expect(sessionManager.start(false, 60_000)).rejects.toThrow(ConfigIssuesError);
    expect(sessionManager.getStatus().active).toBe(false);
  });

  it('does not gate a simulated run, which never deploys the profile', async () => {
    // Sim reads the committed config_base → sim_config overlay. Gating it on profile issues that
    // are not in effect would teach operators to press Start twice by reflex.
    writeProfile(BROKEN);
    await sessionManager.start(false, 60_000, true);
    expect(sessionManager.getStatus().active).toBe(true);
    expect(deployed()).toBe('# deployed-marker\n');   // still untouched
    await sessionManager.stop();
  });
});

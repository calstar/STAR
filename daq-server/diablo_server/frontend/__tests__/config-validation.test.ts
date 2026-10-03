/**
 * The config rules that refuse a run.
 *
 * These used to live inside the config editor as JSX, which made them advisory: an operator could
 * read a red box on the Boards tab and start a run on exactly that config anyway. They now sit in
 * shared/config-validation.ts and are evaluated by SessionManager.start(), which refuses to start
 * or deploy anything when any of them fires.
 *
 * That makes false positives expensive in a specific way: an operator who is blocked on something
 * that is not really wrong learns to press Start twice by reflex, and the gate stops meaning
 * anything. So roughly half of what is pinned here is the *quiet* cases — a config with no states,
 * a profile with no CSVs, a rig that does not use the PWM controller.
 */
import { describe, it, expect } from 'vitest';
import {
  validateConfigForRun,
  groupIssuesByPage,
  countByLevel,
  CONFIG_PAGE_LABELS,
} from '@/lib/config-validation';

/** A minimal config that passes every rule — each test breaks exactly one thing about it. */
const cleanConfig = () => ({
  boards: {
    pt_board_1: { type: 'PT', board_id: 1, enabled: true, ip: '192.0.2.1' },
    act_board: { type: 'ACTUATOR', board_id: 12, enabled: true, ip: '192.0.2.12' },
  },
  actuator_roles: {
    'Fuel Press': ['NC', 3, 12, 'pwm_fuel'],
    'LOX Press': ['NO', 8, 12, 'pwm_ox'],
  },
  states: [
    { id: 1, name: 'Idle' },
    { id: 2, name: 'Armed', is_abort: true },
    { id: 3, name: 'Fire' },
  ],
  fire: { state: 'Fire', expiry_target: 'Armed' },
});

/** Grids matching cleanConfig: columns = states, actuator rows = [actuator_roles] keys. */
const cleanCsv = () => ({
  actuators: [
    ',Idle,Armed,Fire',
    'Fuel Press,CLOSE,CLOSE,OPEN',
    'LOX Press,CLOSE,CLOSE,OPEN',
  ].join('\n'),
  delays: [
    ',Idle,Armed,Fire',
    'Fuel Press,0,0,0',
    'LOX Press,0,0,0',
  ].join('\n'),
  transitions: [
    ',Idle,Armed,Fire',
    'Idle,1,1,0',
    'Armed,1,1,1',
    'Fire,0,1,1',
  ].join('\n'),
});

const messages = (issues: { message: string }[]) => issues.map((i) => i.message).join(' | ');

describe('validateConfigForRun — the clean case', () => {
  it('reports nothing for a config that is fit to run', () => {
    expect(validateConfigForRun(cleanConfig(), cleanCsv())).toEqual([]);
  });
});

describe('boards', () => {
  it.each([0, -1, 256, 4294967321, 25.5, NaN, Infinity, '25', undefined, null])(
    'rejects invalid environmental ID %s', (id) => {
      const issues = validateConfigForRun({ boards: {
        env: { type: 'ENVIRONMENTAL', board_id: id },
      } });
      expect(issues).toEqual([expect.objectContaining({ page: 'boards', level: 'error',
        message: expect.stringContaining('integer from 1 to 255') })]);
    });

  it('rejects duplicate environmental IDs, including the legacy id spelling', () => {
    const issues = validateConfigForRun({ boards: {
      first: { type: 'ENVIRONMENTAL', board_id: 25 },
      second: { type: 'ENVIRONMENTAL', id: 25 },
    } });
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.level === 'error' && i.message.includes('also claimed'))).toBe(true);
  });

  it('accepts environmental boundaries and distinct full IDs, ignoring disabled boards', () => {
    expect(validateConfigForRun({ boards: {
      one: { type: 'ENVIRONMENTAL', board_id: 1 },
      max: { type: 'ENVIRONMENTAL', board_id: 255 },
      first: { type: 'ENVIRONMENTAL', board_id: 25 },
      second: { type: 'ENVIRONMENTAL', board_id: 35 },
      off: { type: 'ENVIRONMENTAL', board_id: 25, enabled: false },
      invalidOff: { type: 'ENVIRONMENTAL', board_id: 256, enabled: false },
    } })).toEqual([]);
  });

  it('reports two same-type enabled boards colliding on one Elodin slot', () => {
    // board_id % 10 is the slot, so 12 and 22 are the same slot: the two boards merge into one
    // entity and half the channels silently vanish.
    const cfg: any = cleanConfig();
    cfg.boards.act_board_2 = { type: 'ACTUATOR', board_id: 22, enabled: true, ip: '192.0.2.22' };
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues).toHaveLength(2);           // each board names the other
    expect(issues.every((i) => i.page === 'boards' && i.level === 'error')).toBe(true);
    expect(messages(issues)).toContain('Slot 2');
  });

  it('does not report a slot shared by boards of different types', () => {
    // The packet id's high byte separates the types, so this is legal. Reporting it would be the
    // kind of false positive that trains operators to ignore the gate.
    const cfg: any = cleanConfig();
    cfg.boards.pt_board_2 = { type: 'PT', board_id: 12, enabled: true, ip: '192.0.2.13' };
    expect(validateConfigForRun(cfg, cleanCsv())).toEqual([]);
  });

  it('does not report a disabled board', () => {
    const cfg: any = cleanConfig();
    cfg.boards.act_board_2 = { type: 'ACTUATOR', board_id: 22, enabled: false };
    expect(validateConfigForRun(cfg, cleanCsv())).toEqual([]);
  });
});

describe('controller', () => {
  it('reports a PWM output with no actuator assigned', () => {
    const cfg: any = cleanConfig();
    cfg.actuator_roles['Fuel Press'] = ['NC', 3, 12];   // assignment dropped
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues).toHaveLength(1);
    expect(issues[0].page).toBe('controller');
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('pwm_fuel');
  });

  it('stays quiet for a rig that does not use the PWM controller at all', () => {
    const cfg: any = cleanConfig();
    cfg.actuator_roles['Fuel Press'] = ['NC', 3, 12];
    cfg.actuator_roles['LOX Press'] = ['NO', 8, 12];
    expect(validateConfigForRun(cfg, cleanCsv())
      .filter((i) => i.page === 'controller')).toEqual([]);
  });
});

describe('state machine', () => {
  it('reports a duplicate state id', () => {
    const cfg: any = cleanConfig();
    cfg.states[2].id = 1;
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ page: 'state', level: 'error' });
    expect(issues[0].message).toContain('1');
  });

  it('reports a duplicate state name', () => {
    const cfg: any = cleanConfig();
    cfg.states[2].name = 'Armed';
    const issues = validateConfigForRun(cfg, cleanCsv());
    // The rename also makes the tables disagree with the state list, which is the point: a
    // half-finished rename is exactly how this happens.
    expect(issues.some((i) => i.message.includes('Duplicate state name'))).toBe(true);
    expect(issues.every((i) => i.page === 'state')).toBe(true);
  });

  it('reports a fire timer that expires into a transition the table refuses', () => {
    // The failure this catches: the burn ends, the sequencer commands Fire → Armed, the transition
    // table says no, and the system sits in fire with a dead timer.
    const csv = cleanCsv();
    csv.transitions = [',Idle,Armed,Fire', 'Idle,1,1,0', 'Armed,1,1,1', 'Fire,0,0,1'].join('\n');
    const issues = validateConfigForRun(cleanConfig(), csv);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ page: 'state', level: 'error' });
    expect(issues[0].message).toContain('Fire → Armed');
  });

  it('reports a fire state that is not in the state list', () => {
    const cfg: any = cleanConfig();
    cfg.fire.state = 'Burn';
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(messages(issues)).toContain('"Burn"');
  });

  it('reports a table column that is not a state', () => {
    const csv = cleanCsv();
    csv.actuators = [',Idle,Armed,Fire,Vent', 'Fuel Press,CLOSE,CLOSE,OPEN,CLOSE',
                     'LOX Press,CLOSE,CLOSE,OPEN,CLOSE'].join('\n');
    const issues = validateConfigForRun(cleanConfig(), csv);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('Vent'))).toBe(true);
  });

  it('warns — not errors — when an actuator has no row in the table', () => {
    // The sequencer never commands it in any state. Real, but not a reason the config cannot load,
    // so it must not be dressed up as one.
    const cfg: any = cleanConfig();
    cfg.actuator_roles['Fuel Vent'] = ['NC', 4, 12];
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ page: 'state', level: 'warn' });
    expect(issues[0].message).toContain('Fuel Vent');
  });

  it('warns when no state is flagged Abort', () => {
    const cfg: any = cleanConfig();
    cfg.states[1].is_abort = false;
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ page: 'state', level: 'warn' });
  });
});

describe('staying quiet on partial configs', () => {
  it('skips the state-machine rules when the config declares no states', () => {
    // A config with no [[states]] is a different and much louder problem. Burying it under one
    // complaint per table column helps nobody, and would block a start for the wrong reason.
    const cfg: any = cleanConfig();
    delete cfg.states;
    delete cfg.fire;
    expect(validateConfigForRun(cfg, cleanCsv())).toEqual([]);
  });

  it('skips the CSV rules on a profile that has no state tables', () => {
    expect(validateConfigForRun(cleanConfig(), { actuators: '', delays: '', transitions: '' }))
      .toEqual([]);
    expect(validateConfigForRun(cleanConfig(), undefined)).toEqual([]);
  });

  it('does not throw on an empty config object', () => {
    expect(() => validateConfigForRun({})).not.toThrow();
  });
});

describe('grouping for the session page', () => {
  it('groups by editor tab, drops empty pages, and labels each with its tab name', () => {
    const cfg: any = cleanConfig();
    cfg.boards.act_board_2 = { type: 'ACTUATOR', board_id: 22, enabled: true };
    cfg.states[1].is_abort = false;
    const groups = groupIssuesByPage(validateConfigForRun(cfg, cleanCsv()));
    expect(groups.map((g) => g.page)).toEqual(['boards', 'state']);
    expect(groups[0].label).toBe(CONFIG_PAGE_LABELS.boards);
    expect(groups.every((g) => g.issues.length > 0)).toBe(true);
  });

  it('counts errors and warnings separately', () => {
    const cfg: any = cleanConfig();
    cfg.boards.act_board_2 = { type: 'ACTUATOR', board_id: 22, enabled: true };
    cfg.states[1].is_abort = false;
    expect(countByLevel(validateConfigForRun(cfg, cleanCsv()))).toEqual({ errors: 2, warnings: 1 });
  });

  it('every page id a rule can emit has a label', () => {
    // The session page renders group.label; an id with no entry would show a blank heading.
    const ids = Object.keys(CONFIG_PAGE_LABELS);
    expect(ids).toContain('boards');
    expect(ids).toContain('controller');
    expect(ids).toContain('state');
    expect(ids).toContain('system');   // used by the "profile could not be read" issue
  });
});

// ── Roles vs active_connectors ───────────────────────────────────────────────
// active_connectors is wire-level (broadcast to the board, decides what it samples);
// sensor_roles is naming (display, calibration keying, abort_pts). Only one direction is a
// fault worth gating on: a role that names a channel the board never samples can never show
// data. The reverse — a sampled channel with no role — is the normal case for spare
// channels and is deliberately not reported; on the real rig it produced nine warnings.
describe('roles vs active_connectors', () => {
  const withLc = (connectors: number[], roles: Record<string, number>, extra: Record<string, unknown> = {}) => {
    const cfg: any = cleanConfig();
    cfg.boards.lc_board_2 = {
      type: 'LC', board_id: 42, enabled: true, ip: '192.0.2.42',
      active_connectors: connectors, ...extra,
    };
    cfg.sensor_roles_lc_board_2 = roles;
    return cfg;
  };

  it('warns when a role names a channel the board is not told to sample', () => {
    const issues = validateConfigForRun(withLc([1, 2, 6], { Thrust: 1, Ghost: 4 }), cleanCsv());
    const issue = issues.find((i) => i.message.includes('Ghost'));
    expect(issue).toBeTruthy();
    expect(issue!.level).toBe('warn');
    expect(issue!.page).toBe('boards');
  });

  it('does not block a run over it — a warning, not an error', () => {
    const issues = validateConfigForRun(withLc([1], { Thrust: 1, Ghost: 4 }), cleanCsv());
    expect(issues.every((i) => i.level === 'warn')).toBe(true);
  });

  it('stays quiet about spare channels — an unnamed channel is the normal case', () => {
    const issues = validateConfigForRun(withLc([1, 2, 6], { Thrust: 1 }), cleanCsv());
    expect(issues.some((i) => i.message.includes('lc_board_2'))).toBe(false);
  });

  it('is quiet when every role names a sampled channel', () => {
    const issues = validateConfigForRun(withLc([1, 2, 6], { A: 1, B: 2, C: 6 }), cleanCsv());
    expect(issues.some((i) => i.message.includes('lc_board_2'))).toBe(false);
  });

  it('says nothing about a DISABLED board — it samples nothing', () => {
    const issues = validateConfigForRun(
      withLc([1], { Ghost: 4 }, { enabled: false }), cleanCsv());
    expect(issues.some((i) => i.message.includes('lc_board_2'))).toBe(false);
  });

  it('does not judge an ACTUATOR board by the sensor-role map', () => {
    // Its channels are named in [actuator_roles] as ["NC", channel, board_id]; comparing it
    // against sensor_roles would flag every channel it has.
    const cfg: any = cleanConfig();
    cfg.boards.act_x = {
      type: 'ACTUATOR', board_id: 13, enabled: true, ip: '192.0.2.13',
      active_connectors: [1, 2, 3],
    };
    const issues = validateConfigForRun(cfg, cleanCsv());
    expect(issues.some((i) => i.message.includes('act_x'))).toBe(false);
  });

  it('an empty connector list with roles still warns — empty means no channels now', () => {
    const issues = validateConfigForRun(withLc([], { Thrust: 1 }), cleanCsv());
    expect(issues.some((i) => i.message.includes('Thrust'))).toBe(true);
  });
});

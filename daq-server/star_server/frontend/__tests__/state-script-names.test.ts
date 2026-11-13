/**
 * Name checking and rename propagation for dynamic-state scripts.
 *
 * The case that matters most is the collision one. On the shipped `server` profile FUEL_VENT is
 * BOTH an actuator role and a state name, and on `digital-twin` FUEL_UPSTREAM is both an actuator
 * and a PT sensor. Names in this language resolve positionally — the argument slot decides the
 * namespace — which is what makes both legal, and what makes a namespace-scoped regex a correct
 * tool here rather than a shortcut.
 *
 * A bare `text.replaceAll('FUEL_VENT', …)` when renaming the *state* would rewrite
 * `open_valve(FUEL_VENT)` into a valve that does not exist, validation would then reject it, and
 * an unrelated rename would have silently made a working state unenterable.
 */
import { describe, it, expect } from 'vitest';
import {
  slugify, isValidSlug, isValidScriptFilename, scanScriptNames, renameScriptSlug, checkScriptNames,
} from '@/lib/state-script-names';

const tables = {
  actuators: new Set(['FUEL_VENT', 'GSE_HIGH_PRESS_CONTROL', 'FUEL_UPSTREAM']),
  sensors: new Set(['GN2_HIGH', 'GN2_REGULATED', 'FUEL_UPSTREAM']),
  states: new Set(['IDLE', 'PRESS_STANDBY', 'FUEL_VENT', 'FIRE']),
  allowedTransitions: new Set(['IDLE', 'PRESS_STANDBY', 'FUEL_VENT']),
};

describe('slugify', () => {
  it('matches the C++ rule', () => {
    expect(slugify('GN2 High')).toBe('GN2_HIGH');
    expect(slugify('GSE High Press Control')).toBe('GSE_HIGH_PRESS_CONTROL');
    expect(slugify('  Fuel   Vent  ')).toBe('FUEL_VENT');
    expect(slugify('Chamber Mid PT 1')).toBe('CHAMBER_MID_PT_1');
  });

  it('rejects what cannot be a bare identifier', () => {
    expect(isValidSlug('GN2_HIGH')).toBe(true);
    expect(isValidSlug('2COLD')).toBe(false);
    expect(isValidSlug('FUEL-VENT')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });
});

describe('script filenames', () => {
  it('accepts a bare name and refuses anything path-shaped', () => {
    expect(isValidScriptFilename('copv_press.script')).toBe(true);
    expect(isValidScriptFilename('a-b_1.script')).toBe(true);
    expect(isValidScriptFilename('../../etc/passwd')).toBe(false);
    expect(isValidScriptFilename('sub/dir.script')).toBe(false);
    expect(isValidScriptFilename('notes.txt')).toBe(false);
    expect(isValidScriptFilename('.script')).toBe(false);
  });
});

describe('scanning', () => {
  it('assigns a namespace by argument position, not by spelling', () => {
    const refs = scanScriptNames(
      'open_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\nx = pressure(GN2_HIGH)\n',
    );
    expect(refs).toEqual([
      { slug: 'FUEL_VENT', ns: 'actuator', line: 1 },
      { slug: 'GN2_HIGH', ns: 'sensor', line: 3 },
      { slug: 'FUEL_VENT', ns: 'state', line: 2 },
    ].sort((a, b) => a.line - b.line || a.ns.localeCompare(b.ns)).sort((a, b) => a.line - b.line));
  });

  it('ignores names inside comments', () => {
    expect(scanScriptNames('# open_valve(NOPE)\ndelay(1)\n')).toEqual([]);
  });
});

describe('checking', () => {
  it('says nothing about a clean script', () => {
    expect(checkScriptNames(
      'open_valve(FUEL_VENT)\ndelay(0.5)\nclose_valve(FUEL_VENT)\ntransition_to(PRESS_STANDBY)\n',
      tables,
    )).toEqual([]);
  });

  it('accepts a name that is a valve AND a state, in both positions', () => {
    expect(checkScriptNames('open_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\n', tables)).toEqual([]);
  });

  it('accepts a name that is a valve AND a sensor', () => {
    expect(checkScriptNames('x = pressure(FUEL_UPSTREAM)\nopen_valve(FUEL_UPSTREAM)\n', tables))
      .toEqual([]);
  });

  it('catches a typo and suggests the real name', () => {
    const [issue] = checkScriptNames('open_valve(FUEL_VNT)\n', tables);
    expect(issue.line).toBe(1);
    expect(issue.message).toContain('FUEL_VENT');
  });

  it('catches a state the transitions table forbids', () => {
    const [issue] = checkScriptNames('transition_to(FIRE)\n', tables);
    expect(issue.message).toContain('not allowed to transition');
  });

  it('checks a state name in the ACTUATOR slot against actuators', () => {
    // IDLE is a real state, but it is not a valve.
    const [issue] = checkScriptNames('open_valve(IDLE)\n', tables);
    expect(issue.message).toContain('no actuator named IDLE');
  });
});

describe('rename propagation', () => {
  it('rewrites transition_to but NOT open_valve for the same slug', () => {
    const src = 'open_valve(FUEL_VENT)\ndelay(1)\ntransition_to(FUEL_VENT)\n';
    const out = renameScriptSlug(src, 'state', 'FUEL_VENT', 'FUEL_DUMP');
    expect(out).toContain('open_valve(FUEL_VENT)');
    expect(out).toContain('transition_to(FUEL_DUMP)');
  });

  it('rewrites both valve calls when the ACTUATOR is renamed, leaving the state alone', () => {
    const src = 'open_valve(FUEL_VENT)\nclose_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\n';
    const out = renameScriptSlug(src, 'actuator', 'FUEL_VENT', 'FUEL_DUMP');
    expect(out).toContain('open_valve(FUEL_DUMP)');
    expect(out).toContain('close_valve(FUEL_DUMP)');
    expect(out).toContain('transition_to(FUEL_VENT)');
  });

  it('rewrites a sensor only inside pressure()', () => {
    const src = 'x = pressure(FUEL_UPSTREAM)\nopen_valve(FUEL_UPSTREAM)\n';
    const out = renameScriptSlug(src, 'sensor', 'FUEL_UPSTREAM', 'FUEL_UP');
    expect(out).toContain('pressure(FUEL_UP)');
    expect(out).toContain('open_valve(FUEL_UPSTREAM)');
  });

  it('tolerates whitespace inside the call', () => {
    expect(renameScriptSlug('transition_to(  IDLE  )\n', 'state', 'IDLE', 'HOME'))
      .toContain('HOME');
  });

  it('leaves a script that never names the slug untouched', () => {
    const src = 'delay(1)\n';
    expect(renameScriptSlug(src, 'state', 'IDLE', 'HOME')).toBe(src);
  });
});

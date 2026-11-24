/**
 * A transition row must carry one cell per header column (C2-8). A short row used to be read
 * left-aligned: every cell after the missing one landed under the wrong state, so ten rows of the
 * shipped table put a 1 under Fire and none under Emergency Abort. The sequencer refuses such a
 * file; the backend refuses it too, so the GUI never draws doors the stand will not open.
 *
 * Hermetic: temp files only, plus a read of the shipped profiles.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseStateTransitionsCSV, raggedTransitionRows } from '../state-csv/state-transitions.js';

const here = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(here, '..', '..', '..', '..', 'config', 'profiles');

describe('state_transitions.csv width', () => {
  it('refuses a table with a row one cell short', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transitions-'));
    const path = join(dir, 't.csv');
    writeFileSync(path, ',Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1\nFire,1,0,1\n');
    expect(raggedTransitionRows(',Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1\n')).toEqual([
      'line 3: "Armed" has 3 cells, the header has 4',
    ]);
    expect(parseStateTransitionsCSV(path)).toEqual([]);
  });

  it('reads the same table once every row is full', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transitions-'));
    const path = join(dir, 't.csv');
    writeFileSync(path, ',Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1,0\nFire,1,0,1\n');
    expect(parseStateTransitionsCSV(path).length).toBeGreaterThan(0);
  });

  it('every shipped profile table is full width', () => {
    const profiles = readdirSync(profilesDir).filter((p) =>
      existsSync(join(profilesDir, p, 'state_transitions.csv')),
    );
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    for (const p of profiles) {
      const text = readFileSync(join(profilesDir, p, 'state_transitions.csv'), 'utf-8');
      expect(raggedTransitionRows(text), p).toEqual([]);
    }
  });
});

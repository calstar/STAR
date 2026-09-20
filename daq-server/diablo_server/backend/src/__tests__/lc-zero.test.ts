/**
 * Load-cell re-zero: the backend half.
 *
 * The backend does NOT apply the zero — C++ does, inside the conversion, because
 * model(adc - shift) is not model(adc) - k. So nothing here checks arithmetic on samples. What is
 * checked is everything that makes a run reconstructible afterwards, because the zero changes what
 * `force_kg` means: the same ADC code deliberately maps to different weights in runs with
 * different zeros, and the only things that say so are the per-run snapshot and this record.
 *
 * The cases that matter most:
 *   - a torn read must not clear the map (every LC reading would silently revert to the
 *     un-zeroed scale for one poll interval), and
 *   - a `recal` line must be written when a re-fit moves the shift with no operator action, or
 *     every reconstruction is wrong from the re-fit onward.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let TMP: string;
let ZERO_FILE: string;

vi.mock('../routes/calibration-profiles.js', () => ({
  zeroPath: () => ZERO_FILE,
  tarePath: () => path.join(path.dirname(ZERO_FILE), 'lc_tare.json'),
  livePath: () => path.join(path.dirname(ZERO_FILE), 'cubic_calibration.json'),
  profilesDir: () => path.join(path.dirname(ZERO_FILE), 'profiles'),
}));

const { loadZeroMap, resetZeroState, setRunDir, currentZeros } = await import('../lc-zero.js');

function writeZeros(
  entries: Array<{ entity: string; uid?: number; adcAtZero?: number; calZero?: number; shift?: number }>,
): void {
  const zeros = entries.map((e) => ({
    uid: e.uid ?? 4201,
    entity: e.entity,
    adc_at_zero: e.adcAtZero ?? -300000,
    cal_zero_adc: e.calZero ?? 500000,
    shift_codes: e.shift ?? (e.adcAtZero ?? -300000) - (e.calZero ?? 500000),
    domain_min: 500000,
    domain_max: 600000,
    set_at_ms: 1757800000000,
    basis_fp: 7,
  }));
  fs.writeFileSync(ZERO_FILE, JSON.stringify({ version: 1, zeros }));
}

/** Nudge the mtime so the mtime-gated reload actually re-reads. */
function touch(): void {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(ZERO_FILE, t, t);
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-zero-test-'));
  ZERO_FILE = path.join(TMP, 'lc_zero.json');
  resetZeroState();
  setRunDir(null);
});

afterEach(() => {
  resetZeroState();
  setRunDir(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('the zero map', () => {
  it('reads what the service wrote, including the fit window', () => {
    writeZeros([{ entity: 'LC2_Cal.CH1' }]);
    const z = currentZeros();
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({
      entity: 'LC2_Cal.CH1',
      uid: 4201,
      adcAtZero: -300000,
      calZeroAdc: 500000,
      shiftCodes: -800000,
      domainMin: 500000,
      domainMax: 600000,
    });
  });

  it('keeps the last good map through a torn read, and clears only on ENOENT', () => {
    writeZeros([{ entity: 'LC2_Cal.CH1' }]);
    expect(loadZeroMap().size).toBe(1);

    // The service writes tmp+rename, but a reader can still lose the race. Clearing here would
    // put every load cell back on the un-zeroed scale for one poll interval and then back again.
    fs.writeFileSync(ZERO_FILE, '{ "zeros": [ {');
    touch();
    expect(loadZeroMap().size).toBe(1);
    expect(loadZeroMap().get('LC2_Cal.CH1')?.shiftCodes).toBe(-800000);

    fs.unlinkSync(ZERO_FILE);
    expect(loadZeroMap().size).toBe(0);
  });

  it('picks up a changed shift when the mtime moves', () => {
    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -300000 }]);
    expect(loadZeroMap().get('LC2_Cal.CH1')?.shiftCodes).toBe(-800000);
    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -100000 }]);
    touch();
    expect(loadZeroMap().get('LC2_Cal.CH1')?.shiftCodes).toBe(-600000);
  });

  it('skips an entry whose shift is not finite', () => {
    // C++ refuses to record one; this is the second line of defence. A NaN here would be
    // subtracted from every code on the channel and take the whole series with it.
    fs.writeFileSync(
      ZERO_FILE,
      JSON.stringify({
        version: 1,
        zeros: [{ uid: 4201, entity: 'LC2_Cal.CH1', adc_at_zero: 1, cal_zero_adc: 2, shift_codes: null }],
      }),
    );
    expect(loadZeroMap().size).toBe(0);
    expect(currentZeros()).toEqual([]);
  });

  it('skips an entry with no entity string, rather than inventing one', () => {
    // Node keys on the string C++ wrote and must never re-derive it: slot is board_id % 10, so
    // PT board 22 and LC board 42 are both slot 2 and a derived key collides them.
    fs.writeFileSync(
      ZERO_FILE,
      JSON.stringify({ version: 1, zeros: [{ uid: 4201, adc_at_zero: 1, cal_zero_adc: 2, shift_codes: -1 }] }),
    );
    expect(loadZeroMap().size).toBe(0);
  });
});

describe('the run record', () => {
  it('appends one line per change and never rewrites', () => {
    const runDir = path.join(TMP, 'daq_20260920_120000');
    setRunDir(runDir);

    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -300000 }]);
    loadZeroMap();

    // A re-fit moves cal_zero_adc with NO operator action, at the same captured code. There is no
    // click to hang a write off, so this path is the only thing that records it.
    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -300000, calZero: 502000 }]);
    touch();
    loadZeroMap();

    const lines = fs
      .readFileSync(path.join(runDir, 'lc_zero.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'set', shiftCodes: -800000, adcAtZero: -300000 });
    expect(lines[1]).toMatchObject({ event: 'recal', shiftCodes: -802000, adcAtZero: -300000 });
    expect(lines[1].appliedAtMs).toBeGreaterThanOrEqual(lines[0].appliedAtMs);
  });

  it('calls a new capture a set, not a recal', () => {
    const runDir = path.join(TMP, 'daq_20260920_120001');
    setRunDir(runDir);
    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -300000 }]);
    loadZeroMap();
    writeZeros([{ entity: 'LC2_Cal.CH1', adcAtZero: -310000 }]);
    touch();
    loadZeroMap();

    const lines = fs
      .readFileSync(path.join(runDir, 'lc_zero.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['set', 'set']);
  });

  it('records a clear when the zero goes away', () => {
    const runDir = path.join(TMP, 'daq_20260920_120002');
    setRunDir(runDir);
    writeZeros([{ entity: 'LC2_Cal.CH1' }]);
    loadZeroMap();
    fs.unlinkSync(ZERO_FILE);
    loadZeroMap();

    const lines = fs
      .readFileSync(path.join(runDir, 'lc_zero.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['set', 'clear']);
    // A clear returns the channel to the calibration's own scale, which is shift 0 — not the
    // absence of a line. The viewer replays this as a step.
    expect(lines[1].shiftCodes).toBe(0);
  });

  it('carries everything a viewer needs to recompute kilograms from raw codes', () => {
    // The run archive holds raw_adc and force_kg. force_kg was produced with the shift already
    // applied, so reproducing or undoing it needs the shift AND the window it was derived
    // against. If a field disappears from here, an archived run stops being reconstructible and
    // nothing fails until someone tries, months later.
    const runDir = path.join(TMP, 'daq_20260920_120003');
    setRunDir(runDir);
    writeZeros([{ entity: 'LC2_Cal.CH1' }]);
    loadZeroMap();

    const line = JSON.parse(fs.readFileSync(path.join(runDir, 'lc_zero.jsonl'), 'utf8').trim());
    for (const k of [
      'entity', 'uid', 'event', 'shiftCodes', 'adcAtZero', 'calZeroAdc',
      'domainMin', 'domainMax', 'setAtMs', 'appliedAtMs',
    ]) {
      expect(line, `the run record must carry ${k}`).toHaveProperty(k);
    }
  });

  it('applies the zero but writes nothing when there is no active session', () => {
    setRunDir(null);
    writeZeros([{ entity: 'LC2_Cal.CH1' }]);
    expect(() => loadZeroMap()).not.toThrow();
    expect(currentZeros()).toHaveLength(1);
    expect(fs.existsSync(path.join(TMP, 'lc_zero.jsonl'))).toBe(false);
  });
});

describe('the command and the endpoint', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  it('re-zero is command 9, distinct from the tare on 8 and zero_all on 0', () => {
    const handler = src('calibration-handler.ts');
    const zeroCase = handler.slice(handler.indexOf("case 'zero_lc':"));
    expect(zeroCase).toContain('publishCalibrationCommand(host, 9,');
    // The three commands that all sound like "make it read zero" must stay distinct.
    expect(handler.slice(handler.indexOf("case 'tare_lc':"))).toContain('publishCalibrationCommand(host, 8,');
  });

  it('the endpoint serves the file, because the command has no reply', () => {
    expect(src('api-server.ts')).toContain("'/api/lc_zero'");
    expect(src('api-server.ts')).toContain('currentZeros()');
  });

  it('never applies the shift in the backend — that is C++ inside the curve', () => {
    // model(adc - shift) is not model(adc) - k. A subtraction here would look plausible, be
    // wrong by the curve's own nonlinearity, and be wrong in exactly the regime the zero exists
    // to rescue: far from where the cubic was fitted.
    const zero = src('lc-zero.ts');
    // Strip comments first: the header explains at length what it does NOT do, and matching that
    // prose is not a test of anything.
    const code = zero.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('ParsedSensorData');  // it never sees a sample
    expect(code).not.toContain('component');         // it never emits a stream component
    expect(code).not.toContain('force_kg');
  });
});

/**
 * Load-cell tare: the backend half.
 *
 * Every case here names a specific way the tare could put a wrong number in front of an
 * operator, or make one disappear. The two that matter most:
 *   - a torn read must not clear the map (every LC plot would jump by the tare amount for one
 *     poll interval and then jump back), and
 *   - the derived value must reach history and the client outbox identically, or a reconnect
 *     shows gross where the live stream showed tared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The module resolves its file path through routes/calibration-profiles.js, which walks the repo
// for scripts/calibration/calibrations. Point it at a scratch dir instead.
let TMP: string;
let TARE_FILE: string;

vi.mock('../routes/calibration-profiles.js', () => ({
  tarePath: () => TARE_FILE,
  zeroPath: () => path.join(path.dirname(TARE_FILE), 'lc_zero.json'),
  livePath: () => path.join(path.dirname(TARE_FILE), 'cubic_calibration.json'),
  profilesDir: () => path.join(path.dirname(TARE_FILE), 'profiles'),
}));

const { expandWithTare, loadTareMap, tareOffsetKg, resetTareState, setRunDir, currentTares } =
  await import('../lc-tare.js');

function writeTares(entries: Array<{ entity: string; uid?: number; adc?: number; kg: number }>): void {
  const tares = entries.map((e) => ({
    uid: e.uid ?? 4201,
    entity: e.entity,
    adc_at_tare: e.adc ?? 1000,
    offset_kg: e.kg,
    set_at_ms: 1757800000000,
    curve_fp: 7,
  }));
  fs.writeFileSync(TARE_FILE, JSON.stringify({ version: 1, tares }));
}

/** One calibrated LC packet as elodin-protocol parses it: the value plus its two raw echoes. */
function lcPacket(entity: string, grossKg: number, rawAdc = 12345) {
  return [
    { entity, component: 'force_kg', value: grossKg, timestamp: 1000 },
    { entity, component: 'raw_adc_counts', value: rawAdc, timestamp: 1000 },
    { entity, component: 'raw_adc', value: rawAdc, timestamp: 1000 },
  ];
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-tare-test-'));
  TARE_FILE = path.join(TMP, 'lc_tare.json');
  resetTareState();
  setRunDir(null);
});

afterEach(() => {
  resetTareState();
  setRunDir(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('expandWithTare', () => {
  it('adds force_kg_tared without touching force_kg or the raw echoes', () => {
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    const out = expandWithTare(lcPacket('LC2_Cal.CH1', 50));

    // force_kg stays gross: the calibration page reads it, and the operator types the true
    // weight of a known mass against that reading.
    expect(out.find((p) => p.component === 'force_kg')!.value).toBe(50);
    expect(out.find((p) => p.component === 'force_kg_tared')!.value).toBe(30);
    // Raw echoes are the calibration capture path's input. Taring them would poison the fit.
    expect(out.find((p) => p.component === 'raw_adc_counts')!.value).toBe(12345);
    expect(out.find((p) => p.component === 'raw_adc')!.value).toBe(12345);
    // Exactly one derived point, and it came from force_kg. Checking only the raw values above
    // is not enough: deriving a SECOND tared point off a raw echo leaves those values intact and
    // would sail past, while putting a 12325-kg spike in the same series as the real reading.
    expect(out.filter((p) => p.component === 'force_kg_tared')).toHaveLength(1);
    expect(out).toHaveLength(4);
  });

  it('emits force_kg_tared even when untared, so a 0 offset is not mistaken for a dead stream', () => {
    const out = expandWithTare(lcPacket('LC2_Cal.CH1', 50));
    const tared = out.find((p) => p.component === 'force_kg_tared');
    expect(tared).toBeDefined();
    expect(tared!.value).toBe(50);
  });

  it('leaves non-load-cell packets exactly as they arrived', () => {
    const pt = [{ entity: 'PT1_Cal.CH3', component: 'pressure_psi', value: 220, timestamp: 1 }];
    expect(expandWithTare(pt)).toEqual(pt);
  });

  it('treats a NaN offset as no tare rather than poisoning the series', () => {
    // A NaN would survive to the caller's own Number.isFinite guard, which drops the point —
    // so the whole tared series would silently vanish from the plot with nothing logged.
    fs.writeFileSync(
      TARE_FILE,
      '{"version":1,"tares":[{"uid":4201,"entity":"LC2_Cal.CH1","adc_at_tare":1000,"offset_kg":null,"set_at_ms":1,"curve_fp":7}]}',
    );
    const out = expandWithTare(lcPacket('LC2_Cal.CH1', 50));
    const tared = out.find((p) => p.component === 'force_kg_tared')!;
    expect(Number.isFinite(tared.value)).toBe(true);
    expect(tared.value).toBe(50);

    // And it never enters the map at all, so the status endpoint the calibration UI polls cannot
    // report a tare that is not a number. Asserting only the streamed value above would pass on
    // the strength of the second guard in tareOffsetKg and leave this one untested.
    expect(currentTares()).toEqual([]);
  });
});

describe('the tare map', () => {
  it('keeps the previous map when the file is torn, and empties only on ENOENT', () => {
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(20);

    // A reader can still lose a race with the service's tmp+rename. Clearing here would make
    // every LC plot jump by 20 kg for one poll interval and then jump back.
    fs.writeFileSync(TARE_FILE, '{"version":1,"tares":[{"entity":"LC2_Cal.C');
    fs.utimesSync(TARE_FILE, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(20);

    // A removed file is different: that is the session-start clear, and it must take effect.
    fs.unlinkSync(TARE_FILE);
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(0);
  });

  it('picks up a changed offset when the file mtime moves', () => {
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(20);
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 25 }]);
    fs.utimesSync(TARE_FILE, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(25);
  });

  it('a removed file clears the map, and is the only thing that does', () => {
    // Nothing in the backend unlinks this file any more — tares persist across sessions. The
    // path still has to work, because an operator removing it by hand while the service is down
    // is the remaining way to force every channel back to absolute.
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(20);
    fs.unlinkSync(TARE_FILE);
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(0);
    expect(currentTares()).toEqual([]);
  });
});

describe('live stream and reconnect backfill agree', () => {
  // The bug guarded here: applying the tare in the outbox drain instead of before
  // history.record() leaves the live plot tared and the backfill after a reconnect gross, so a
  // dropped WebSocket silently changes every load-cell number on screen.
  //
  // server.ts calls httpServer.listen() at import, so emitSensorWindow cannot be driven
  // directly from a unit test. Both halves of the invariant are pinned instead:

  it('feeds one already-tared array to both sinks, which then hold identical values', async () => {
    const { HistoryCache } = await import('../history-cache.js');
    const { ClientOutbox } = await import('../client-outbox.js');

    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    const history = new HistoryCache({ maxPoints: 256, maxKeys: 32, staleMs: 60_000 });
    const outbox = new ClientOutbox();

    // Exactly what emitSensorWindow does: record to history, then stage to the client, from the
    // same points. Anything derived before this call reaches both; anything derived after
    // reaches only one.
    for (const grossKg of [50, 51, 52]) {
      const tared = expandWithTare(lcPacket('LC2_Cal.CH1', grossKg))
        .find((p) => p.component === 'force_kg_tared')!;
      const key = `${tared.entity}.${tared.component}`;
      const points = [{ tMs: 1000 + grossKg, value: tared.value }];
      history.record(key, points[0].tMs, points[0].value);
      outbox.push(key, tared.entity, tared.component, points);
    }

    const staged = outbox.drain().flatMap((s) => s.points.map((p) => p.value));
    const backfilled = Array.from(
      history.buildPayload({ keys: ['LC2_Cal.CH1.force_kg_tared'] }, 1000)[
        'LC2_Cal.CH1.force_kg_tared'
      ].values,
    );

    expect(staged).toEqual([30, 31, 32]);
    expect(backfilled).toEqual(staged);
  });

  it('server.ts derives the tare at the parse site, not in the drain loop', () => {
    // A wiring assertion, deliberately narrow: it checks the one line that decides which side of
    // history.record() the subtraction lands on. Moving the tare into the drain means deleting
    // this wrapper, and this test is what notices.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    expect(src).toContain('expandWithTare(parseElodinPacket(');

    const drain = src.slice(src.indexOf('cs.outbox.drain()'), src.indexOf('cs.pacer.noteFlush'));
    expect(drain).not.toContain('force_kg_tared');
    expect(drain).not.toContain('tareOffset');
  });
});

describe('a session start does NOT clear the tare', () => {
  // This describe block used to assert the opposite, and the inversion is the point: tares and
  // zeros both persist across sessions now, by request. An operator zeroes an unloaded cell and
  // tares a standing tank once, and every run that day inherits both.
  //
  // What the old assertions protected — that a clear, if one exists, happens in the ONE window
  // where no calibration_service is alive to rewrite the file from memory — is preserved as a
  // comment in service-controller.ts rather than as behaviour. If a clear is ever re-added, it
  // belongs between waitUntilSettled and the pipeline start, and nowhere else.
  const controllerSrc = () =>
    fs.readFileSync(path.join(__dirname, '..', 'service-controller.ts'), 'utf8');

  it('neither start branch removes the tare file', () => {
    const src = controllerSrc();
    expect(src).not.toContain('clearTareFile');
    expect(src).not.toContain('unlinkSync');
  });

  it('nothing tells a live service to drop its tares at session start', () => {
    // The mock-mode companion to the unlink: cmd 8 clear-all, published once the pipeline was up.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    expect(server).not.toContain('publishClearAllTares');
    const handler = fs.readFileSync(path.join(__dirname, '..', 'calibration-handler.ts'), 'utf8');
    expect(handler).not.toContain('publishClearAllTares');
  });

  it('snapshots the calibration and the zero beside the run, so the archive stays readable', () => {
    // force_kg now means different weights for the same ADC code in runs with different zeros.
    // Without these copies the archive has no record of which zero produced its numbers.
    const src = controllerSrc();
    const snap = src.slice(src.indexOf('function snapshotRunCalibration'));
    expect(snap).toContain('calibration.json');
    expect(snap).toContain('lc_zero.json');
    expect(src.indexOf('snapshotRunCalibration(dbDir)')).toBeGreaterThan(-1);
  });

  it('forgets the held map when the run stops', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.ts'), 'utf8');
    const stop = src.slice(src.indexOf('this.onStopped();') - 600, src.indexOf('this.onStopped();'));
    expect(stop).toContain('resetTareState()');
    expect(stop).toContain('setRunDir(null)');
  });
});

describe('the run record', () => {
  it('appends one line per change and never rewrites', () => {
    const runDir = path.join(TMP, 'daq_20260914_120000');
    setRunDir(runDir);
    const jsonl = path.join(runDir, 'lc_tare.jsonl');

    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    loadTareMap();

    // A re-cal rewrites offset_kg with NO operator action, at the same ADC code. Missing this
    // line makes every reconstruction wrong from the re-cal onward.
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20.44 }]);
    fs.utimesSync(TARE_FILE, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    loadTareMap();

    const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].event).toBe('set');
    expect(lines[0].offsetKg).toBe(20);
    expect(lines[1].event).toBe('recal');
    expect(lines[1].offsetKg).toBe(20.44);
    expect(lines[1].appliedAtMs).toBeGreaterThanOrEqual(lines[0].appliedAtMs);
  });

  it('records a clear when the tare goes away', () => {
    const runDir = path.join(TMP, 'daq_20260914_120001');
    setRunDir(runDir);
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    loadTareMap();
    fs.unlinkSync(TARE_FILE);
    loadTareMap();

    const lines = fs
      .readFileSync(path.join(runDir, 'lc_tare.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['set', 'clear']);
  });

  it('applies the tare but writes nothing when there is no active session', () => {
    setRunDir(null);
    writeTares([{ entity: 'LC2_Cal.CH1', kg: 20 }]);
    expect(() => loadTareMap()).not.toThrow();
    expect(tareOffsetKg('LC2_Cal.CH1')).toBe(20);
    expect(fs.readdirSync(TMP).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });
});

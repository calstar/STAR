import { describe, expect, it } from 'vitest';
import { findFire, matchColumn, parseDaqCsv, residual } from './daqcsv';

// The two shapes daq-server's web viewer exports (tools/postprocessing/webviewer/backend/series.py),
// written out by hand.
const WIDE = [
  'time,PT_OUP,PT_ODP,LC_CHAMBER_1',
  ',Ox Upstream,Ox Downstream,Load cell',
  '1000.00,563.0,0.2,0',
  '1000.10,563.1,0.1,0',
  '1000.20,555.0,300.0,1500',
  '1000.30,550.0,548.0,2200',
].join('\n');
const LONG = [
  'time,component,value',
  '1000.00,PT_OUP,563.0',
  '1000.00,PT_ODP,0.2',
  '1000.10,PT_ODP,0.1',
  '1000.20,PT_ODP,300.0',
].join('\n');

describe('a DAQ export read back', () => {
  it('reads the wide shape and skips its role row', () => {
    const d = parseDaqCsv(WIDE);
    expect(d.shape).toBe('wide');
    expect(d.t).toEqual([1000, 1000.1, 1000.2, 1000.3]);
    expect(d.columns.PT_ODP).toEqual([0.2, 0.1, 300, 548]);
  });

  it('pivots the long shape on the union of times', () => {
    const d = parseDaqCsv(LONG);
    expect(d.shape).toBe('long');
    expect(d.t).toEqual([1000, 1000.1, 1000.2]);
    expect(d.columns.PT_OUP).toEqual([563, null, null]);
  });

  it('finds a channel by its name inside a longer column name', () => {
    const d = parseDaqCsv('time,board2.PT_ODP.psi,PT_OUP\n0,1,2');
    expect(matchColumn(d, 'PT_ODP')).toBe('board2.PT_ODP.psi');
    expect(matchColumn(d, 'PT_OUP')).toBe('PT_OUP');
    expect(matchColumn(d, 'PT_FUP')).toBeNull();
  });

  it('puts Fire where the downstream transducer crosses halfway, between samples', () => {
    const d = parseDaqCsv(WIDE);
    // Predicted: 0 psig before Fire, 548 after; halfway 274 lies 0.1 s × (274 - 0.1)/(300 - 0.1) into the step.
    const fire = findFire(d.t, d.columns.PT_ODP, 0, 548)!;
    expect(fire).toBeCloseTo(1000.1 + 0.1 * (274 - 0.1) / (300 - 0.1), 6);
  });

  it('measures the bias and scatter between the two', () => {
    const r = residual([0, 0.1, 0.2], [10, 10, 10], [0, 0.1, 0.2], [11, 12, 13], 0, 1)!;
    expect(r.mean).toBeCloseTo(2, 9);
    expect(r.rms).toBeCloseTo(Math.sqrt((1 + 4 + 9) / 3), 9);
  });
});

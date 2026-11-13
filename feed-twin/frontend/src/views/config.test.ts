import { describe, expect, it } from 'vitest';
import { fromPsia } from '../lib/pressure';
import { rowCommit } from '../lib/entry';
import { fmt } from './Config';

describe('a Configuration row shows the number the stand runs on', () => {
  it('network_tolerance down to its 1e-8 floor, not "0"', () => {
    expect(fmt(1e-8, 1e-6)).toBe('1e-8');
    expect(fmt(1e-7, 1e-6)).toBe('1e-7');
    expect(fmt(5e-7, 1e-6)).toBe('5e-7');
    expect(fmt(1e-6, 1e-6)).toBe('0.000001');
    expect(Number(fmt(2.5e-7, 1e-6))).toBe(2.5e-7);
  });
  it('the rest as before: to the step\'s places at least', () => {
    expect(fmt(9.7, 5)).toBe('9.7');
    expect(fmt(0.001, 1e-6)).toBe('0.0010');
    expect(fmt(0, 1e-6)).toBe('0');
    expect(fmt(120, 5)).toBe('120');
  });
});

// Rows as /api/tunables gives them (backend/tunables.py).
const dome = { unit: 'psi', gauge_wire: true, low: 0, high: 1000, step: 5 };
const copv = { unit: 'psi', gauge_wire: true, low: 100, high: 6000, step: 50 };
const iterations = { unit: '', low: 5, high: 500, step: 5 };
const liveStep = { unit: 's', low: 0.002, high: 0.25, step: 0.005 };

describe('a Configuration box commits a number, not an emptied box', () => {
  it('backspacing a row to retype it commits nothing', () => {
    expect(rowCommit('', dome, 535)).toBeNull();
    expect(rowCommit('   ', copv, 3750)).toBeNull();
    expect(rowCommit('', iterations, 120)).toBeNull();
    expect(rowCommit('', liveStep, 0.02)).toBeNull();
  });
  it('nor half a number', () => {
    expect(rowCommit('-', iterations, 120)).toBeNull();
    expect(rowCommit('.', liveStep, 0.02)).toBeNull();
  });
  it('a number typed is committed, snapped and kept in bounds', () => {
    expect(rowCommit('565', dome, 535)).toBeCloseTo(fromPsia(565), 9);
    expect(rowCommit('200', iterations, 120)).toBe(200);
    expect(rowCommit('9000', iterations, 120)).toBe(500);
  });
  it('the value shown typed back is no change', () => {
    expect(rowCommit('549.7', dome, 535)).toBeNull();
    expect(rowCommit('120', iterations, 120)).toBeNull();
  });
});

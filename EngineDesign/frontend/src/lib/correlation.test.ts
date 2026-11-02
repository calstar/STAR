import { describe, expect, it } from 'vitest';
import { correlationIsInformative } from './correlation';

const ramp = Array.from({ length: 11 }, (_, i) => 578 - 17.3 * i);
const loose = [[1, 0.6], [0.6, 1]];

describe('correlationIsInformative', () => {
  it('folds the grid on a one-way tank ramp, whatever it holds', () => {
    // 2026-10-17 dry run: a 578 -> 405 psia linear ramp gave a grid of ±1.00.
    expect(correlationIsInformative(loose, ramp, ramp)).toBe(false);
  });
  it('shows it when a profile turns back and a pair comes apart', () => {
    const wave = [500, 520, 510, 530, 505];
    expect(correlationIsInformative(loose, wave, ramp)).toBe(true);
  });
  it('folds it when every pair still moves together', () => {
    const wave = [500, 520, 510, 530, 505];
    expect(correlationIsInformative([[1, -0.99], [-0.99, 1]], wave, wave)).toBe(false);
  });
});

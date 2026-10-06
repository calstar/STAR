import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeUnits, PRESETS, PSI_PER_BAR, UnitsProvider, DEFAULT_SYSTEM } from '../units';
import { Chart } from './Chart';
import { inUnits, unitDigits } from './quantity';
import { yScaleFor } from './scale';
import type { ChartData } from './types';

/** A tank pressure trace in the model's units: psia. */
const tank: ChartData = {
  t: [0, 1, 2, 3],
  series: [{ key: 'tank', label: 'LOX tank', color: '--lx-lox', values: [578, 571, 566, null] }],
  yUnit: 'psia',
  limits: [{ value: 600, status: 'warn', label: 'MAWP' }],
  band: { lo: 550, hi: 580, status: 'ok' },
  yPin: [0, null],
};

describe('a chart given in model units', () => {
  it('draws in bar when the page is in bar: values, limits, bands, pins, the unit and its decimals', () => {
    const u = makeUnits(PRESETS.si);
    const d = inUnits(tank, 'pressure', u);
    expect(d.yUnit).toBe('bar(a)');
    expect(d.series[0].values[0]).toBeCloseTo(578 / PSI_PER_BAR, 9);
    expect(d.series[0].values[3]).toBeNull();
    expect(d.limits?.[0].value).toBeCloseTo(600 / PSI_PER_BAR, 9);
    expect(d.band?.lo).toBeCloseTo(550 / PSI_PER_BAR, 9);
    expect(d.yPin?.[0]).toBe(0);
    expect(d.digits).toBe(1);
    // The axis it gets is a bar axis: round bar ticks around 40 bar, not psi ones around 600.
    const y = yScaleFor(d, 180);
    expect(y.hi).toBeGreaterThanOrEqual(600 / PSI_PER_BAR);
    expect(y.hi).toBeLessThan(60);
    for (const t of y.ticks) expect(Math.abs(t / y.step - Math.round(t / y.step))).toBeLessThan(1e-9);
  });

  it('reads gauge against the given zero', () => {
    const u = makeUnits(DEFAULT_SYSTEM, 14.7);
    const d = inUnits(tank, { kind: 'pressure', pressure: 'gauge' }, u);
    expect(d.yUnit).toBe('psig');
    expect(d.series[0].values[0]).toBeCloseTo(578 - 14.7, 9);
  });

  it('renders its scale in bar under a bar unit system', () => {
    const html = renderToStaticMarkup(
      <UnitsProvider initial={PRESETS.si} persist={false}>
        <Chart {...tank} quantity="pressure" height={220} />
      </UnitsProvider>,
    );
    expect(html).toContain('data-y-unit="bar(a)"');
    expect(html).toContain('aria-label="LOX tank (bar(a))"');
    expect(html).not.toContain('psia');
  });

  it('switches with the system: psi when the page is in psi', () => {
    const html = renderToStaticMarkup(
      <UnitsProvider initial={DEFAULT_SYSTEM} persist={false}>
        <Chart {...tank} quantity="pressure" height={220} />
      </UnitsProvider>,
    );
    expect(html).toContain('data-y-unit="psia"');
  });

  it('converts force to lbf and mass to lb', () => {
    const u = makeUnits(PRESETS.imperial);
    const f = inUnits({ ...tank, series: [{ ...tank.series[0], values: [4448.2216152605] }] }, 'force', u);
    expect(f.yUnit).toBe('lbf');
    expect(f.series[0].values[0]).toBeCloseTo(1000, 6);
    const m = inUnits({ ...tank, series: [{ ...tank.series[0], values: [0.45359237] }] }, 'mass', u);
    expect(m.yUnit).toBe('lb');
    expect(m.series[0].values[0]).toBeCloseTo(1, 9);
  });
});

describe('yScaleFor', () => {
  it('keeps gridlines at least 28 px apart on a small multiple', () => {
    const d: ChartData = { t: [0, 1], series: [{ key: 'isp', label: 'Isp', color: '--lx-hot', values: [223.27, 224.42] }], yUnit: 's' };
    for (const px of [80, 110, 150, 240]) {
      const y = yScaleFor(d, px);
      expect(px / (y.ticks.length - 1), `${px}`).toBeGreaterThanOrEqual(28);
    }
  });
});

describe('unitDigits', () => {
  it('reads a unit\'s resolution when only one quantity uses it', () => {
    expect(unitDigits('bar(a)')).toBe(1);
    expect(unitDigits('psia')).toBe(0);
    expect(unitDigits('lb/s')).toBe(3);
    expect(unitDigits('psi')).toBeNull();
    expect(unitDigits('s')).toBeNull();
    expect(unitDigits('')).toBeNull();
  });

  it('keeps a bar readout to 0.1 bar on an axis ticked in whole bar', () => {
    const d: ChartData = { t: [0, 1], series: [{ key: 'p', label: 'Tank', color: '--lx-lox', values: [26.1, 41.7] }], yUnit: 'bar(a)' };
    const y = yScaleFor(d, 120);
    expect(y.step).toBe(5);
    expect(y.digits).toBe(0);
    expect(y.readoutDigits).toBe(1);
  });
});

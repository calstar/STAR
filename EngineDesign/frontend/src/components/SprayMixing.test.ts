import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SprayMixingView, fmtValue } from './SprayMixing';
import type { SprayReport } from '../api/client';
import spray from './__fixtures__/spray_doublet_6500N.json';

/** engine/core/injectors/spray_report.py output for the 6.5 kN doublet (scripts/spray_report.py). */
const R = spray as unknown as SprayReport;

describe('spray and mixing view', () => {
  const html = renderToStaticMarkup(createElement(SprayMixingView, { report: R }));

  it('shows every section and every row the backend sent', () => {
    for (const s of R.sections) {
      expect(html).toContain(s.title);
      for (const r of s.rows) expect(html).toContain(r.label.replace('&', '&amp;'));
    }
  });

  it('shows each sensitivity case with its thrust change from the base', () => {
    for (const c of R.sensitivity!) expect(html).toContain(c.case.replace('&', '&amp;'));
    const em70 = R.sensitivity!.find((c) => c.case.includes('0.70'))!;
    expect(html).toContain(`${(em70.F! - R.sensitivity![0].F!).toFixed(0)}`);
  });

  it('marks a warned row', () => {
    expect(R.sections.flatMap((s) => s.rows).some((r) => r.status === 'warn')).toBe(true);
    expect(html).toContain('#fbbf24');
  });

  it('formats numbers without inventing precision', () => {
    expect(fmtValue(null)).toBe('—');
    expect(fmtValue(323912.4)).toBe('3.24e+5');
    expect(fmtValue(0.78424)).toBe('0.7842');
    expect(fmtValue(160.73)).toBe('160.7');
  });
});

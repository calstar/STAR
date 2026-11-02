// What the config dialog writes back on Save, run through the small hook
// runtime (hookRuntime.ts) so its fill-from-the-drawing effects happen.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

import { find, rt, textOf } from './hookRuntime';
import { ConfigDialog } from './ConfigDialog';
import type { ConfigPatch } from './ConfigDialog';
import { addLeg, emptySketch, setBend, setSectionBore, splitAt } from './sketch/model';
import type { Sketch } from './sketch/model';

beforeEach(() => rt.reset());

type Data = Parameters<typeof ConfigDialog>[0]['data'];

function dialog(kind: 'node' | 'edge', data: Data) {
  let saved: ConfigPatch | null = null;
  const tree = () => rt.settle(() => ConfigDialog({
    open: true, kind, data, readOnly: false, onClose: () => {},
    onSave: (patch: ConfigPatch) => { saved = patch; },
  }));
  return {
    text: () => find(tree(), () => true).map(textOf).join(' '),
    save(): ConfigPatch {
      const footer = find(tree(), e => e.props?.footer !== undefined)[0].props.footer;
      const button = find(footer, e => e.type === 'button' && textOf(e) === 'Save')[0];
      (button.props.onClick as () => void)();
      return saved!;
    },
  };
}

describe('a sketched line with no inner diameter', () => {
  const run = (s: Sketch, params: Record<string, unknown> = {}) =>
    dialog('edge', { componentType: 'pipe', label: '', params, sketch: s } as unknown as Data);
  const noBore = () => setBend(addLeg(addLeg(emptySketch('in'), { x: 0, y: 200 }), { x: 150, y: 200 }), 0, 38.1)!;

  it('is said, on the dialog, before it is saved', () => {
    expect(run(noBore()).text()).toMatch(/no inner diameter/);
    expect(run(setSectionBore(noBore(), null, 10.92)).text()).not.toMatch(/no inner diameter/);
  });

  it('saves no bore for the line, rather than a 0 that reads as a size', () => {
    const out = run(noBore()).save();
    expect(out.params.bore).toBeUndefined();
    expect(out.segments![0].bore).toBeUndefined();
    expect(out.params.length!.value).toBeGreaterThan(0);
  });

  it('leaves no line-level bore behind it either: the sketch is the run', () => {
    // A bore typed on the line before it was sketched is superseded by the
    // segments in feed-twin; left on the line it read as the run's size.
    const out = run(noBore(), { bore: { value: 9.5, unit: 'mm', source: 'measured' } }).save();
    expect(out.params.bore).toBeUndefined();
  });

  it('saves the sketch\'s bore when it has one', () => {
    const out = run(setSectionBore(noBore(), null, 10.92)).save();
    expect(out.params.bore).toMatchObject({ value: 10.92, unit: 'mm' });
  });

  it('is said on a run already saved that way, whose sketch is gone', () => {
    // LE4 (3)'s fuel tank-to-main run as it is in the drawing: the sketch's
    // segments, bore 0, and no sketch left to give a diameter to.
    const seg = (bore: number) => ({
      id: 'seg_1', method: 'itemised', standard: 'tube',
      bore: { value: bore, unit: 'mm', source: 'estimated', reference: 'from the centerline sketch' },
      length: { value: 429.54, unit: 'mm', source: 'measured', reference: 'from the centerline sketch' },
      fittings: [{ id: 'fit_1', kind: 'bend', count: 1, boreMm: bore, angleDeg: 45 }],
    });
    const line = (bore: number) => dialog('edge', {
      componentType: 'pipe', label: '', params: { length: { value: 0.519, unit: 'm', source: 'measured' } },
      segments: [seg(bore)],
    } as unknown as Data).text();
    expect(line(0)).toMatch(/It states no bore, and the solver prices nothing for it/);
    expect(line(10.92)).not.toMatch(/no bore/);
  });
});

describe('a run only part of which states a bore', () => {
  // feed-twin refers a stretch with no bore of its own to the narrowest bore
  // stated on the rest of the run (`SegmentedPipe._segment_dp`), so that
  // stretch is priced, at a borrowed bore; only a run with no bore anywhere is
  // priced at nothing. The dialog said "prices nothing" for both.
  const seg = (id: string, more: Record<string, unknown>) => ({
    id, method: 'itemised', length: { value: 300, unit: 'mm', source: 'measured' }, ...more,
  });
  const bore = (value: number) => ({ bore: { value, unit: 'mm', source: 'measured' } });
  const listed = (segments: unknown[]) => dialog('edge', {
    componentType: 'pipe', label: '', params: {}, segments,
  } as unknown as Data).text();

  it('says, of a sketch split before its diameter was given, that the stretch borrows the rest\'s', () => {
    let s = splitAt(addLeg(addLeg(emptySketch('mm'), { x: 300, y: 0 }), { x: 300, y: 400 }), 300);
    s = setSectionBore(s, s.sections[0].id, 7.7);
    const text = dialog('edge', { componentType: 'pipe', label: '', params: {}, sketch: s } as unknown as Data).text();
    expect(text).toMatch(/Part of the run has no inner diameter\. The solver prices that stretch at the narrowest diameter/);
    expect(text).not.toMatch(/prices\s+nothing/);
  });

  it('says the same of a saved list, and "nothing" only where nothing on the run has a bore', () => {
    expect(listed([seg('s1', {}), seg('s2', bore(7.7))]))
      .toMatch(/Part of it states no bore; the solver prices that part at the narrowest bore stated/);
    expect(listed([seg('s1', {}), seg('s2', bore(7.7))])).not.toMatch(/prices nothing/);
    expect(listed([seg('s1', {}), seg('s2', {})])).toMatch(/It states no bore, and the solver prices nothing for it/);
  });

  it('asks a bore only of a segment the solver sizes by one', () => {
    // A Δp-against-ṁ table off a flow bench is priced as measured, bore or no;
    // an unstated segment prices nothing, bore or no. A K needs one to refer to.
    const curve = { id: 'c1', method: 'curve', curve: { mdot: [0.1, 0.2], mdotUnit: 'kg/s', dp: [1e4, 4e4], dpUnit: 'Pa' } };
    expect(listed([curve])).not.toMatch(/no bore/);
    expect(listed([{ id: 'u1', method: 'unstated' }])).not.toMatch(/no bore/);
    expect(listed([curve, seg('s1', {})]))
      .toMatch(/Part of it states no bore, and the solver prices nothing for that part/);
    expect(listed([{ id: 'k1', method: 'measured_K', K: { value: 2, unit: '-', source: 'measured' } }]))
      .toMatch(/It states no bore, and the solver prices nothing for it/);
  });
});

describe('options the dialog does not show', () => {
  const man = (options: Record<string, string>) =>
    ({ componentType: 'MAN', label: 'FV-MAN', options }) as unknown as Data;

  it('keeps a hand valve standing open through a save', () => {
    expect(dialog('node', man({ flowCoefficient: 'Cd', normalPosition: 'open' })).save().options.normalPosition).toBe('open');
  });

  it('keeps a symbol\'s option it does not name, rather than erasing it on save', () => {
    // Written by another tool or by hand. The dialog writes back what it
    // holds, wholesale, and used to hold only the options its spec names.
    const out = dialog('node', man({ flowCoefficient: 'Cd', actuator: 'DAQ-7' })).save().options;
    expect(out.actuator).toBe('DAQ-7');
    expect(out.normalPosition).toBe('closed');
  });

  it('still drops a line\'s hose construction once the line is no longer a hose', () => {
    // A line's options are all the dialog's own, one of them derived; kept
    // wholesale, a hardline would carry its old hose construction forever.
    const out = dialog('edge', {
      componentType: 'pipe', label: '', params: {}, lineType: 'pipe',
      options: { hose: 'no', construction: 'smooth_bore' },
    } as unknown as Data).save();
    expect(out.lineType).toBe('pipe');
    expect(out.options.construction).toBeUndefined();
  });
});

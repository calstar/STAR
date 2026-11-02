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
import { addLeg, emptySketch, setBend, setSectionBore } from './sketch/model';
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
});

describe('options the dialog does not show', () => {
  const man = (options: Record<string, string>) =>
    ({ componentType: 'MAN', label: 'FV-MAN', options }) as unknown as Data;

  it('keeps a hand valve standing open through a save', () => {
    expect(dialog('node', man({ Cd: 'manual', normalPosition: 'open' })).save().options.normalPosition).toBe('open');
  });

  it('keeps a symbol\'s option it does not name, rather than erasing it on save', () => {
    // Written by another tool or by hand. The dialog writes back what it
    // holds, wholesale, and used to hold only the options its spec names.
    const out = dialog('node', man({ Cd: 'manual', actuator: 'DAQ-7' })).save().options;
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

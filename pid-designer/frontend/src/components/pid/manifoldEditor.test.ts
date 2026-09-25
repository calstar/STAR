// The Geometry editor while the dialog round it changes.
//
// The editor's draft is state, and what it does when the outlet count or the
// direction is changed in the dialog -- or when the dialog is filled afresh
// from the drawing -- happens in an effect and on the render after it, which
// a server render never reaches. So the editor and the dialog are run here
// through the small hook runtime in hookRuntime.ts, one instance at a time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

import { find, rt, textOf } from './hookRuntime';
import { ManifoldEditor, drawnGeometry, rebaseDraft } from './ManifoldEditor';
import type { ManifoldGeometry } from './ManifoldEditor';
import { fractionOf, perimeterPoint } from './manifoldGeometry';
import { NumberField } from './NumberField';
import { ConfigDialog } from './ConfigDialog';
import { manifoldLayout } from './nodes/ManifoldNode';
import type { PIDNodeData } from './types';

beforeEach(() => rt.reset());

type Props = Parameters<typeof ManifoldEditor>[0];
type El = ReactElement<Record<string, unknown>>;

/** One editor, mounted and then handed new props the way the dialog hands them. */
function editor(first: Omit<Props, 'onSave' | 'ports'>) {
  let saved: ManifoldGeometry | null = null;
  let props: Props = { ...first, ports: {}, onSave: g => { saved = g; } };
  let tree = rt.settle(() => ManifoldEditor(props)) as El;
  const redraw = () => { tree = rt.settle(() => ManifoldEditor(props)) as El; };
  const button = () => find(tree, e => e.type === 'button')[0];
  return {
    /** The dialog changed something the editor is handed. */
    set(patch: Partial<Props>) { props = { ...props, ...patch }; redraw(); },
    /** What the Save button reads, and whether it can be pressed. */
    get label() { return textOf(button()); },
    get lit() { return !button().props.disabled; },
    /** The draft, as a press of Save would hand it over. */
    draft(): ManifoldGeometry {
      (button().props.onClick as () => void)();
      return saved!;
    },
    /** Type a size into the width or height box. */
    size(key: 'width' | 'height', v: number) {
      const [w, h] = find(tree, e => e.type === NumberField);
      ((key === 'width' ? w : h).props.onCommit as (v: number) => void)(v);
      redraw();
    },
    /** Drag port `id` to `along` px down `side` of the block, as a pointer would. */
    drag(id: string, side: 'top' | 'right' | 'bottom' | 'left', along: number) {
      const svg = find(tree, e => e.type === 'svg')[0];
      (svg.props.ref as { current: unknown }).current =
        { getBoundingClientRect: () => ({ left: 0, top: 0, width: 260, height: 190 }) };
      const port = find(tree, e => e.type === 'g' && e.key === id)[0];
      (port.props.onPointerDown as (e: unknown) => void)({ stopPropagation() {} });
      redraw();
      const block = find(tree, e => e.type === 'rect')[0].props as { x: number; y: number; width: number; height: number };
      const k = block.width / this.draft().width;
      const at = {
        top: { x: along * k, y: 0 }, bottom: { x: along * k, y: block.height },
        left: { x: 0, y: along * k }, right: { x: block.width, y: along * k },
      }[side];
      const move = find(tree, e => e.type === 'svg')[0].props.onPointerMove as (e: unknown) => void;
      move({ clientX: block.x + at.x, clientY: block.y + at.y });
      (find(tree, e => e.type === 'svg')[0].props.onPointerUp as () => void)();
      redraw();
    },
  };
}

/** Each port of a layout as side and px along it, rounded to the tenth. */
const drawn = (outlets: number, orientation: string, g?: ManifoldGeometry) => {
  const l = manifoldLayout(outlets, orientation, g);
  return {
    size: [l.width, l.height],
    ports: Object.fromEntries(Object.entries(l.ports).map(([id, p]) => [id, `${p.side} ${Math.round(p.along * 10) / 10}`])),
  };
};

describe('the Geometry editor follows the dialog round it', () => {
  it('opens on the manifold as drawn, with nothing to save', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    expect(ed.label).toBe('Saved');
    expect(ed.lit).toBe(false);
    expect(ed.draft()).toEqual(drawnGeometry(4, 'horizontal'));
  });

  it('grows with the outlet count, with the new outlets where the drawing puts them', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    ed.set({ outlets: 6 });
    // Nothing has been moved, so there is still nothing to save.
    expect(ed.label).toBe('Saved');
    expect(ed.lit).toBe(false);
    expect(drawn(6, 'horizontal', ed.draft())).toEqual(drawn(6, 'horizontal'));
  });

  it('turns with the direction', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    ed.set({ orientation: 'vertical' });
    expect(ed.label).toBe('Saved');
    expect(drawn(4, 'vertical', ed.draft())).toEqual(drawn(4, 'vertical'));
  });

  it('keeps a port that was moved where it was put, and grows the block round it', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    ed.drag('p2', 'bottom', 30);
    expect(drawn(4, 'horizontal', ed.draft()).ports.p2).toBe('bottom 30');
    expect(ed.label).toBe('Save layout');

    ed.set({ outlets: 6 });
    const after = drawn(6, 'horizontal', ed.draft());
    const expected = drawn(6, 'horizontal');
    // The block the drawing would draw, not the four-outlet one the draft
    // was started on: 170 long, the new outlets past the old ones rather
    // than squeezed in among them.
    expect(after.size).toEqual(expected.size);
    expect(after.ports).toEqual({ ...expected.ports, p2: 'bottom 30' });
    expect(ed.label).toBe('Save layout');
  });

  it('keeps a size typed into it, with the ports where the drawing puts them along it', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    ed.size('width', 200);
    ed.set({ outlets: 6 });
    const after = drawn(6, 'horizontal', ed.draft());
    // Twenty thick: the block as the drawing has it, a whole number of grid steps.
    expect(after.size).toEqual([200, 20]);
    expect(after.ports).toEqual(drawn(6, 'horizontal').ports);
  });

  it('keeps a saved layout it has just saved', () => {
    const ed = editor({ outlets: 4, orientation: 'horizontal', geometry: undefined });
    ed.drag('p2', 'bottom', 30);
    const layout = ed.draft();
    // The dialog holds the saved layout and hands it back.
    ed.set({ geometry: layout });
    expect(ed.draft()).toEqual(layout);
    expect(ed.label).toBe('Saved');
  });
});

describe('laying a draft on a changed drawing', () => {
  const ids = (n: number) => Object.keys(drawnGeometry(n, 'horizontal').positions);

  it('hands back the new drawing for a draft with nothing in it', () => {
    const base = drawnGeometry(4, 'horizontal');
    const seed = drawnGeometry(6, 'horizontal');
    expect(rebaseDraft(base, base, seed, ids(6))).toBe(seed);
  });

  it('lands every port on a whole px', () => {
    const base = drawnGeometry(4, 'horizontal');
    // 0.81 of the way round the 120 x 20 block is 33.2 px along the bottom:
    // dragged in an older editor, or saved by hand.
    const draft = { ...base, positions: { ...base.positions, p2: 0.81 } };
    const out = rebaseDraft(draft, base, drawnGeometry(7, 'horizontal'), ids(7));
    expect(out.width).toBe(210);
    const p2 = perimeterPoint(out.positions.p2, out.width, out.height);
    expect(p2.side).toBe('bottom');
    expect(p2.x).toBeCloseTo(33, 9);
    const per = 2 * (out.width + out.height);
    for (const [id, t] of Object.entries(out.positions)) expect(Math.abs(t * per - Math.round(t * per)), id).toBeLessThan(1e-9);
  });

  it('pulls a moved port in to the corner when its side is now shorter than where it was', () => {
    const base = drawnGeometry(4, 'horizontal');
    const draft = { ...base, positions: { ...base.positions, p3: fractionOf({ side: 'bottom', along: 100 }, base.width, base.height) } };
    const out = rebaseDraft(draft, base, drawnGeometry(4, 'vertical'), ids(4));
    // 100 px along a bottom 20 px wide: its far corner.
    const p3 = perimeterPoint(out.positions.p3, out.width, out.height);
    expect({ x: p3.x, y: p3.y }).toEqual({ x: 20, y: 120 });
  });
});

describe('the dialog', () => {
  const manifold = (extra: Partial<PIDNodeData> = {}) =>
    ({ componentType: 'MANIFOLD', label: 'MF-1', options: { outlets: '4', orientation: 'horizontal' }, ...extra }) as unknown as PIDNodeData;

  it('hands the editor a new draft each time it is filled from the drawing, and only then', () => {
    let data = manifold();
    const dialog = () => rt.settle(() => ConfigDialog({
      open: true, kind: 'node', data, readOnly: false, onClose: () => {}, onSave: () => {},
    }));
    const editorIn = () => find(dialog(), e => e.type === ManifoldEditor);

    const first = editorIn();
    expect(first).toHaveLength(1);
    // Rendered again with nothing refilled, it is the same editor: a key
    // that changed on every render would throw away a draft mid-drag.
    expect(editorIn()[0].key).toBe(first[0].key);

    // The drawing changed under the dialog, which refills every field from
    // it; the editor's draft is one of those fields, and is started again
    // from the manifold as it now is.
    data = manifold({ geometry: { width: 118, height: 26, positions: { in: 0.9, p: 0.55, p2: 0.6, p3: 0.65, p4: 0.7 } } });
    const refilled = editorIn();
    expect(refilled[0].key).not.toBe(first[0].key);
    expect(refilled[0].props.geometry).toEqual(data.geometry);
  });
});

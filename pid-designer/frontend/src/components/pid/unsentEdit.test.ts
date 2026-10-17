// An edit the tab closed on before the first edit took the checkout: kept on
// this machine, and weighed on the next open (unsentEdit.ts). The flush itself
// is cut out of PIDDesigner.tsx as written (canvasSource.ts), since the canvas
// needs React Flow and a DOM to mount.
import { describe, expect, it, vi } from 'vitest';
import * as api from '../../api/diagrams';
import { canvasStatement, compiled } from './canvasSource';
import { dropUnsent, keepUnsent, readUnsent, unsentFate } from './unsentEdit';
import type { UnsentEdit } from './unsentEdit';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const node = (id: string, x = 0) => ({ id, type: 'MAN', position: { x, y: 0 }, data: { componentType: 'MAN', label: id } });
const opened = { nodes: [node('a')], edges: [] };
const edited = { nodes: [node('a', 40)], edges: [] };
const S = (d: unknown) => JSON.stringify(d);

describe('the kept edit', () => {
  it('round-trips, and a save of an older state does not drop a newer one', () => {
    const store = memory();
    const e: UnsentEdit = { base: S(opened), doc: edited as never, at: 1 };
    keepUnsent('local/le4', e, store);
    expect(readUnsent('local/le4', store)).toEqual(e);
    dropUnsent('local/le4', S(opened), store);
    expect(readUnsent('local/le4', store)).toEqual(e);
    dropUnsent('local/le4', S(edited), store);
    expect(readUnsent('local/le4', store)).toBeNull();
  });

  it('is offered back only onto the drawing it was made on', () => {
    const e: UnsentEdit = { base: S(opened), doc: edited as never, at: 1 };
    expect(unsentFate(null, { server: S(opened), shown: S(opened) })).toBe('none');
    expect(unsentFate(e, { server: S(opened), shown: S(opened) })).toBe('offer');
    // Somebody saved over it since: kept as a copy, never written over theirs.
    expect(unsentFate(e, { server: S({ nodes: [node('b')], edges: [] }), shown: S(opened) })).toBe('keep');
    // It reached the server after all.
    expect(unsentFate(e, { server: S(edited), shown: S(edited) })).toBe('none');
  });
});

describe('the flush on tab close', () => {
  const effect = canvasStatement('// Best-effort flush to S3 on tab close');

  function mount(held: boolean, drawn: typeof opened) {
    const on: Record<string, () => void> = {};
    const win = { addEventListener: (t: string, f: () => void) => { on[t] = f; }, removeEventListener: () => {} };
    const doc = { visibilityState: 'hidden', addEventListener: (t: string, f: () => void) => { on[t] = f; }, removeEventListener: () => {} };
    const keep = vi.fn();
    const flushDiagram = vi.fn();
    const run = compiled(effect, [
      'useEffect', 'window', 'document', 'unsnapped', 'loadedId', 'diagramKey', 'readOnlyRef', 'heldRef',
      'api', 'snapshot', 'lastSaved', 'serverHas', 'diagramRef', 'claiming', 'keepUnsent',
    ]);
    run(
      (f: () => void) => f(), win, doc, { current: false }, { current: 'local/le4' }, 'local/le4',
      { current: false }, { current: held },
      { toStored: api.toStored, flushDiagram }, { current: drawn },
      { current: S(api.toStored(opened as never)) }, { current: S(opened) }, { owner: 'local', id: 'le4' },
      { current: null }, keep,
    );
    return { on, keep, flushDiagram };
  }

  it('keeps an edit made before the first edit took the checkout', () => {
    const { on, keep, flushDiagram } = mount(false, edited);
    on.pagehide();
    expect(flushDiagram).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledTimes(1);
    const [key, kept] = keep.mock.calls[0] as [string, UnsentEdit];
    expect(key).toBe('local/le4');
    expect(kept.base).toBe(S(opened));
    expect(S(kept.doc)).toBe(S(api.toStored(edited as never)));
  });

  it('keeps nothing when nothing was edited, and still beacons for a holder', () => {
    const idle = mount(false, opened);
    idle.on.pagehide();
    expect(idle.keep).not.toHaveBeenCalled();
    const holder = mount(true, edited);
    holder.on.pagehide();
    expect(holder.flushDiagram).toHaveBeenCalledTimes(1);
    expect(holder.keep).not.toHaveBeenCalled();
  });
});

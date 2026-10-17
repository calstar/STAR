import { describe, expect, it } from 'vitest';
import { mayWrite, tickAction, type TickInput } from './sessionGuard';

const base: TickInput = {
  held: true, ownEpoch: 'e1', sessionEpoch: 'e1', ownToken: 't1', sessionToken: 't1', haveSaved: true,
};

describe('tickAction', () => {
  it('saves the holder’s own design and leaves a viewer alone', () => {
    expect(tickAction(base)).toBe('save');
    expect(tickAction({ ...base, held: false })).toBe('idle');
  });

  it('never saves a design another tab loaded into the shared session', () => {
    // Tab B opened design X in the same user's session; tab A holds Y.
    expect(tickAction({ ...base, sessionToken: 't-other' })).toBe('displaced');
    expect(tickAction({ ...base, held: false, sessionToken: 't-other' })).toBe('displaced');
  });

  it('after a restart the holder puts its design back', () => {
    expect(tickAction({ ...base, sessionEpoch: 'e2', sessionToken: null })).toBe('restore');
    expect(tickAction({ ...base, sessionEpoch: 'e2', sessionToken: 't-other' })).toBe('restore');
  });

  it('after a restart a viewer puts its design back only over the default', () => {
    const viewer = { ...base, held: false, sessionEpoch: 'e2' };
    expect(tickAction({ ...viewer, sessionToken: null })).toBe('restore');
    // The holder already put its design back: the viewer must not load its stale one over it.
    expect(tickAction({ ...viewer, sessionToken: 't-holder' })).toBe('displaced');
  });

  it('with nothing of its own to put back it does nothing', () => {
    expect(tickAction({ ...base, sessionEpoch: 'e2', haveSaved: false })).toBe('idle');
  });
});

describe('mayWrite', () => {
  const saved = JSON.stringify({
    config: { fluids: { fuel: { temperature: 293 } }, lox_tank: { volume: 0.015 } },
    ui: { forward: { loxPressure: '750' } },
  });

  it('an untouched tab does not write panel state its panels derived on load', () => {
    // Same config, keys in another order; only the seeded panel state differs.
    const doc = {
      config: { lox_tank: { volume: 0.015 }, fluids: { fuel: { temperature: 293 } } },
      ui: { forward: { loxPressure: '815.08' } },
    };
    expect(mayWrite(doc, saved, false)).toBe(false);
  });

  it('an untouched tab still writes a config that changed under it', () => {
    const doc = {
      config: { fluids: { fuel: { temperature: 300 } }, lox_tank: { volume: 0.015 } },
      ui: { forward: { loxPressure: '750' } },
    };
    expect(mayWrite(doc, saved, false)).toBe(true);
  });

  it('a tab somebody used writes whatever changed', () => {
    const doc = { config: JSON.parse(saved).config, ui: { forward: { loxPressure: '815.08' } } };
    expect(mayWrite(doc, saved, true)).toBe(true);
  });

  it('with nothing saved yet there is nothing to protect', () => {
    expect(mayWrite({ config: {} }, '', false)).toBe(true);
  });
});

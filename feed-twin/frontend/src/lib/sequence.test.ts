import { describe, expect, it } from 'vitest';
import { isSequence, sequenceText, stepText } from './sequence';

/**
 * Compare listed a run's operator sequence as "1 item": something was
 * commanded mid-burn, but not what. An abort at T+1.5 s is the reason a
 * burn's thrust is half another's (H062), and it reads as one.
 */
describe("a run's operator sequence reads as what was commanded, and when", () => {
  it('names a state and its T+', () => {
    expect(stepText({ t: 0.834, command: { state: 'Engine Abort' } })).toBe('Engine Abort at T+0.83 s');
  });

  it('reads a knob and the dome in psia, as every pressure on the screen', () => {
    // 500 psig on the wire is 514.7 psia.
    expect(stepText({ t: 1, command: { knob: { id: 'dome', value: 500 } } })).toBe('dome to 515 psia at T+1.00 s');
    expect(stepText({ t: 2, command: { dome: 400 } })).toBe('dome to 415 psia at T+2.00 s');
  });

  it('says a valve taken, a release and a setting', () => {
    expect(stepText({ t: 0.5, command: { valve: 'node_13', open: true } })).toBe('node_13 opened at T+0.50 s');
    expect(stepText({ t: 0.5, command: { valve: 'node_13', open: false } })).toBe('node_13 shut at T+0.50 s');
    expect(stepText({ t: 0.5, command: { release: '*' } })).toBe('every valve released at T+0.50 s');
    expect(stepText({ t: 0.5, command: { setup: { ullage_vapour: false } } })).toBe('ullage_vapour set at T+0.50 s');
  });

  it('joins the steps in order', () => {
    const steps = [
      { t: 1, command: { knob: { id: 'dome', value: 600 } } },
      { t: 1.5, command: { state: 'Vent' } },
    ];
    expect(isSequence(steps)).toBe(true);
    expect(sequenceText(steps)).toBe('dome to 615 psia at T+1.00 s; Vent at T+1.50 s');
  });

  it('is not any list', () => {
    expect(isSequence([])).toBe(false);
    expect(isSequence([{ label: 'COPV' }])).toBe(false);
    expect(isSequence('Vent')).toBe(false);
  });
});

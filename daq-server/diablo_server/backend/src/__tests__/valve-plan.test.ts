/**
 * The wire grammar of a per-run valve plan.
 *
 * What is being pinned is not the happy path but the two ways this can go wrong silently:
 *
 *   1. A plan that cannot be written down must be REFUSED, not mangled. The list is comma- and
 *      equals-separated, so a role name containing either would split into two entries naming
 *      valves that do not exist — and the sequencer would refuse the whole transition with a
 *      message about a valve nobody asked about.
 *   2. An empty plan must send NOTHING. `:VALVES=` is a parse error at the sequencer, and a
 *      transition with no overrides has to stay byte-for-byte the frame it was before plans
 *      existed — that is what makes the feature opt-in.
 */
import { describe, it, expect } from 'vitest';
import { valvePlanSuffix, MAX_VALVE_DELAY_MS } from '../valve-plan.js';

const ok = (r: ReturnType<typeof valvePlanSuffix>) => {
  if ('error' in r) throw new Error(`expected a suffix, got error: ${r.error}`);
  return r.suffix;
};
const err = (r: ReturnType<typeof valvePlanSuffix>) => {
  if (!('error' in r)) throw new Error(`expected an error, got suffix: ${r.suffix}`);
  return r.error;
};

describe('valvePlanSuffix', () => {
  it('writes delays and shut valves, keeping spaces in role names', () => {
    const s = ok(valvePlanSuffix({ 'Ox Main': { delayMs: 250 }, 'Fuel Main': { shut: true } }));
    expect(s).toBe(':VALVES=Ox Main=250,Fuel Main=shut');
  });

  it('sends an explicit 0 — the override that cancels a configured stagger', () => {
    // An absent role means "use the CSV's delay", which is the opposite instruction, so a valve
    // the operator set to 0 has to appear on the wire as 0 rather than be omitted.
    expect(ok(valvePlanSuffix({ 'Ox Main': { delayMs: 0 } }))).toBe(':VALVES=Ox Main=0');
    expect(ok(valvePlanSuffix({ 'Ox Main': {} }))).toBe(':VALVES=Ox Main=0');
  });

  it('sends nothing at all for an empty plan', () => {
    expect(ok(valvePlanSuffix({}))).toBe('');
  });

  it('refuses a role name that would break the grammar', () => {
    for (const bad of ['Ox,Main', 'Ox=Main', 'Ox:Main', 'Ox\nMain', '', '   ']) {
      expect(err(valvePlanSuffix({ [bad]: { delayMs: 10 } }))).toMatch(/cannot be sent/);
    }
  });

  it('refuses a delay that is not a whole number of milliseconds in range', () => {
    expect(err(valvePlanSuffix({ 'Ox Main': { delayMs: -1 } }))).toMatch(/invalid delay/);
    expect(err(valvePlanSuffix({ 'Ox Main': { delayMs: 12.5 } }))).toMatch(/invalid delay/);
    expect(err(valvePlanSuffix({ 'Ox Main': { delayMs: Number.NaN } }))).toMatch(/invalid delay/);
    expect(err(valvePlanSuffix({ 'Ox Main': { delayMs: MAX_VALVE_DELAY_MS + 1 } }))).toMatch(/invalid delay/);
    expect(ok(valvePlanSuffix({ 'Ox Main': { delayMs: MAX_VALVE_DELAY_MS } }))).toContain(`=${MAX_VALVE_DELAY_MS}`);
  });

  it('refuses a plan that is not an object of entries', () => {
    expect(err(valvePlanSuffix(null))).toMatch(/expected an object/);
    expect(err(valvePlanSuffix([{ role: 'Ox Main' }]))).toMatch(/expected an object/);
    expect(err(valvePlanSuffix('Ox Main=250'))).toMatch(/expected an object/);
    expect(err(valvePlanSuffix({ 'Ox Main': 250 }))).toMatch(/has no plan/);
  });

  it('shut wins over a delay on the same valve', () => {
    // The card disables the delay input when a valve is held shut, but the two fields can still
    // arrive together from a stale client. A valve that is not opening has nothing to wait for.
    expect(ok(valvePlanSuffix({ 'Ox Main': { shut: true, delayMs: 300 } }))).toBe(':VALVES=Ox Main=shut');
  });
});

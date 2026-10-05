import { describe, expect, it } from 'vitest';
import type { LayerXResult } from '../../api/layerx';
import { PSI } from '../layerx/format';
import { makeUnits, DEFAULT_SYSTEM, PRESETS } from './units';
import {
  diag, diagMissing, flightStabilityOf, fromServerLimit, ledgerOf, limitKindOf, limitsOf, networkOf, resolveRef, serverLimits, testModeOf, trippedOf,
  type ServerLimit,
} from './contract';
import { withContract } from './dev/contractFixture';
import {
  alignFiring, argExtreme, convert, deriveRunData, differenceUnit, displaySpec, figureDelta, firingIndexOf, ghostOf, ghostSeries, gradeRun, indexOfValue, timelineEvents, verdictLine,
  type GradedLimit,
} from './useRunData';

import { FIRING, T, result, sideSummary, summary } from './dev/testRun';

const u = makeUnits(DEFAULT_SYSTEM);
const byKey = (ls: GradedLimit[], k: string) => ls.find((l) => l.key === k)!;

// ------------------------------------------------------------------ helpers

describe('helpers', () => {
  it('maps firing steps to delivered steps', () => {
    const m = firingIndexOf({ firing: FIRING });
    expect([...m.entries()]).toEqual([[3, 0], [4, 1], [5, 2], [6, 3], [7, 4]]);
    expect(alignFiring(T.length, m, [10, 11, 12, null, 14])).toEqual([null, null, null, 10, 11, 12, null, 14, null]);
    expect(alignFiring(3, new Map(), undefined)).toEqual([null, null, null]);
  });

  it('finds the extreme inside a mask, the first of equals', () => {
    const v = [5, 1, 3, 1, null, 9];
    expect(argExtreme(v, 'min')).toBe(1);
    expect(argExtreme(v, 'max')).toBe(5);
    expect(argExtreme(v, 'min', [true, false, true, true, true, false])).toBe(3);
    expect(argExtreme([null, NaN], 'min')).toBe(-1);
  });

  it('finds where a series reads a reported value', () => {
    expect(indexOfValue([0.3, 0.28, 0.25, 0.26], 0.25)).toBe(2);
    expect(indexOfValue([0.3, 0.28, 0.25, 0.26], 0.2501)).toBe(2);
    expect(indexOfValue([0.25, 0.3, 0.25], 0.25, [false, true, true])).toBe(2);
    expect(indexOfValue([1, 2], null)).toBe(-1);
  });

  it('converts a spec to display units edge by edge', () => {
    const s = displaySpec({ limit: 0.2, direction: 'higher-is-safer', far: { warn: 0.4 } }, (x) => x * 100);
    expect(s.limit).toBeCloseTo(20);
    expect(s.far?.warn).toBeCloseTo(40);
    expect(s.warn).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the derived run

describe('deriveRunData', () => {
  const d = deriveRunData(result());

  it('reads the clock: Fire and burnout', () => {
    expect(d.fireT).toBe(0);
    expect(d.burnoutT).toBe(0.25);
    expect(d.gaugeZeroPsia).toBeCloseTo(101325 / PSI, 6);
    expect(d.ambientPsia).toBeCloseTo(94069.72 / PSI, 6);
    expect(d.band.oxidiser).toEqual([0.2, 0.4]);
  });

  it('puts the delivered chamber on the twin\'s firing steps, and keeps the twin\'s as built', () => {
    expect(d.cols.thrust).toEqual([null, null, null, 6950, 7050, 7150, 7250, 6850, null]);
    expect(d.cols.thrustAsBuilt?.[3]).toBe(6900);
    expect(d.cols.pc[4]).toBe(394);
    expect(d.cols.chug?.[5]).toBe(1.18);
    // Firing-only: nothing before Fire, even where the twin wrote a number.
    expect(d.cols.stiffO[1]).toBeNull();
  });

  it('falls back to the twin\'s chamber without a replay', () => {
    const plain = deriveRunData(result({ delivered: null }));
    expect(plain.cols.thrust[3]).toBe(6900);
    expect(plain.cols.thrustAsBuilt).toBeNull();
    expect(plain.cols.chug).toBeNull();
    expect(plain.limits.find((l) => l.key === 'chug')).toBeUndefined();
  });

  it('finds each limit\'s worst moment in the series', () => {
    expect(byKey(d.limits, 'chug').worstT).toBe(0.15);
    // LOX stiffness 0.28 at 0.10, not the same reading before Fire.
    expect(byKey(d.limits, 'stiff_lox').worstT).toBe(0.1);
    expect(byKey(d.limits, 'stiff_fuel').worstT).toBe(0.2);
    // Fuel sags deeper (578 - 550): its lowest firing step.
    expect(byKey(d.limits, 'sag').worstT).toBe(0.15);
    expect(byKey(d.limits, 'sag').focusKey).toBe('fuel_tank');
    // The highest tank pressure, after burnout.
    expect(byKey(d.limits, 'peak_fuel').worstT).toBe(0.3);
    expect(byKey(d.limits, 'bottle').worstT).toBe(0.25);
  });

  it('finds the chug moment in the series when the summary does not name it', () => {
    const r = result();
    r.delivered!.summary.chug_margin_min_t = null;
    expect(byKey(deriveRunData(r).limits, 'chug').worstT).toBe(0.15);
  });

  it('grades as the old verdict did and sorts worst first', () => {
    const s = Object.fromEntries(d.limits.map((l) => [l.key, l.status]));
    expect(s).toEqual({
      chug: 'warn', stiff_lox: 'ok', stiff_fuel: 'ok', peak_lox: 'ok', peak_fuel: 'ok', bottle: 'ok', sag: 'ok', dry_first: 'ok',
    });
    // Which tank runs dry first is information, never amber (the team, 2026-10-03): the chug leads.
    expect(d.limits[0].key).toBe('chug');
    expect(d.verdict).toBe('warn');
  });

  it('prints the limits in the page\'s units', () => {
    expect(byKey(d.limits, 'stiff_fuel').text(u)).toEqual({ value: '25.0 %', limit: '20–40 %' });
    expect(byKey(d.limits, 'bottle').text(u).value).toBe('828 psi');
    const bar = makeUnits(PRESETS.si);
    expect(byKey(d.limits, 'bottle').text(bar).value).toBe('57.1 bar');
    expect(byKey(d.limits, 'dry_first').text(u).value).toBe('Fuel, by 0.02 kg');
  });

  it('makes the timeline\'s events: short labels, burnout, the closest margins', () => {
    const ev = d.events;
    expect(ev.map((e) => e.label)).toEqual(['T−0', 'Fire', 'LOX tank low', 'Min ΔP/Pc', 'Fuel tank low', 'Min chug', 'Fuel dry', 'Burnout'].sort(
      (a, b) => ev.find((e) => e.label === a)!.t - ev.find((e) => e.label === b)!.t || ev.findIndex((e) => e.label === a) - ev.findIndex((e) => e.label === b)));
    expect(ev.find((e) => e.label === 'Fuel dry')?.kind).toBe('dry');
    expect(ev.find((e) => e.label === 'Burnout')?.kind).toBe('burnout');
    // The lower ΔP/Pc of the two sides (fuel, 0.25 at 0.20 s).
    expect(ev.find((e) => e.label === 'Min ΔP/Pc')?.t).toBe(0.2);
    expect(new Set(ev.map((e) => e.key)).size).toBe(ev.length);
  });

  it('takes the figures from the replay when there is one', () => {
    expect(d.figures.impulseNs).toBe(999);
    expect(d.figures.meanThrustN).toBe(7050);
    expect(d.figures.dryWords).toBe('Fuel ran out');
    expect(d.figures.bottleMarginPsi).toBe(1406 - 578);
  });
});

describe('gradeRun edges', () => {
  const d = deriveRunData(result());
  const clock = { t: T, firing: FIRING, burnoutT: 0.25, stiffO: d.cols.stiffO, stiffF: d.cols.stiffF, tankO: d.cols.tankO, tankF: d.cols.tankF, chug: null };

  it('looks for the worst moment on the firing steps only, even in a raw series', () => {
    // The same 0.28 sits before Fire (t = -0.05) and at 0.10: the bar must jump to the burn.
    const raw = { ...clock, stiffO: [0, 0.28, 0, 0.32, 0.28, 0.30, 0.31, 0.33, 0] };
    const g = gradeRun(summary(), { oxidiser: [0.2, 0.4], fuel: [0.2, 0.4] }, raw, undefined);
    expect(byKey(g.limits, 'stiff_lox').worstT).toBe(0.1);
  });

  it('fails a side under its band, warns above it, and uses the floor without a band', () => {
    const s = summary({ ox: sideSummary({ stiffness_min: 0.19 }), fuel: sideSummary({ stiffness_min: 0.45 }) });
    const g = gradeRun(s, { oxidiser: [0.2, 0.4], fuel: [0.2, 0.4] }, clock, undefined);
    expect(byKey(g.limits, 'stiff_lox').status).toBe('bad');
    expect(byKey(g.limits, 'stiff_fuel').status).toBe('warn');
    const floor = gradeRun(summary({ ox: sideSummary({ stiffness_min: 0.16 }) }), { oxidiser: null, fuel: null }, clock, undefined);
    expect(byKey(floor.limits, 'stiff_lox').status).toBe('ok');
    expect(byKey(floor.limits, 'stiff_lox').text(u).limit).toBe('≥ 15 %');
  });

  it('grades a chug margin of exactly 1 amber and under 1 red', () => {
    const at1 = gradeRun(summary(), { oxidiser: null, fuel: null }, clock, undefined, { chug: { min: 1, t: 0.1 } });
    expect(byKey(at1.limits, 'chug').status).toBe('warn');
    const under = gradeRun(summary(), { oxidiser: null, fuel: null }, clock, undefined, { chug: { min: 0.95, t: 0.1 } });
    expect(byKey(under.limits, 'chug').status).toBe('bad');
  });

  it('grades the bottle and the tank peak against their edges', () => {
    const low = gradeRun(summary({ copv_end_psia: 578 + 150 }), { oxidiser: null, fuel: null }, clock, undefined);
    expect(byKey(low.limits, 'bottle').status).toBe('warn');
    const gone = gradeRun(summary({ copv_end_psia: 578 + 50 }), { oxidiser: null, fuel: null }, clock, undefined);
    expect(byKey(gone.limits, 'bottle').status).toBe('bad');
    const hot = gradeRun(summary({ ox: sideSummary({ peak_psia: 14 + 900 }) }), { oxidiser: null, fuel: null }, clock, undefined,
      { mawp: { oxidiser: 1000, fuel: 1000, ambientPsia: 14 } });
    expect(byKey(hot.limits, 'peak_lox').status).toBe('warn');
  });

  it('lists the model\'s health as checks, not bars', () => {
    const g = gradeRun(summary({ failed_steps: 3 }), { oxidiser: null, fuel: null }, clock, undefined, { converged: false, cardOutside: 2 });
    expect(g.checks.map((c) => c.key)).toEqual(['model', 'card', 'solver']);
    expect(g.checks.every((c) => c.status === 'warn')).toBe(true);
  });

  it('shows the engine fit only when it is off, with its worst moment', () => {
    const engine = {
      available: true, against: 'card-geometry' as const, worst: { pc: 0.012, thrust: 0.001, mdot_O: 0.001, mdot_F: 0.001 },
      rows: [{ t: 0.1, available: true, rel: { pc: 0.002, thrust: 0, mdot_O: 0, mdot_F: 0 } }, { t: 0.2, available: true, rel: { pc: -0.012, thrust: 0, mdot_O: 0, mdot_F: 0 } }],
    };
    const g = gradeRun(summary(), { oxidiser: null, fuel: null }, clock, engine);
    expect(byKey(g.limits, 'engine_fit').status).toBe('warn');
    expect(byKey(g.limits, 'engine_fit').worstT).toBe(0.2);
    const fine = gradeRun(summary(), { oxidiser: null, fuel: null }, clock, { ...engine, worst: { pc: 0.001, thrust: 0, mdot_O: 0, mdot_F: 0 } });
    expect(fine.limits.find((l) => l.key === 'engine_fit')).toBeUndefined();
  });
});

describe('verdictLine', () => {
  it('says how many break or need a look', () => {
    expect(verdictLine([{ status: 'ok' }, { status: 'ok' }], [])).toEqual({ status: 'ok', title: 'Within all 2 limits' });
    expect(verdictLine([{ status: 'warn' }, { status: 'ok' }], [{ status: 'warn' }])).toEqual({ status: 'warn', title: 'Within limits, 2 to check' });
    expect(verdictLine([{ status: 'bad' }, { status: 'warn' }], [])).toEqual({ status: 'bad', title: 'Breaks 1 limit' });
  });
});

describe('timelineEvents', () => {
  it('keeps keys unique when two events share a label', () => {
    const ev = timelineEvents([
      { t: 1, kind: 'warn', label: 'Card outside', detail: '' },
      { t: 2, kind: 'warn', label: 'Card outside', detail: '' },
    ], null, []);
    expect(ev.map((e) => e.key)).toEqual(['warn-card-outside', 'warn-card-outside-1']);
  });
});

describe('ghostOf', () => {
  it('reads the compared run on this run\'s clock', () => {
    expect(ghostOf({ t: [0, 0.5, 1] }, { t: [0, 1] }, [10, 20])).toEqual([10, 15, 20]);
    expect(ghostOf({ t: [0, 1] }, null, [1, 2])).toBeNull();
  });
});

describe('figureDelta', () => {
  it('reads the change at the figure\'s digits, signed with a true minus', () => {
    expect(figureDelta(u.time(3.55), u.time(3.44))).toBe('+0.11\u00a0s');
    expect(figureDelta(u.f(6604), u.f(6804), 'pct')).toBe('\u22122.9\u00a0%');
    expect(figureDelta(u.f(6804.2), u.f(6804.1))).toBe('same');
    expect(figureDelta(u.f(6804), null)).toBeNull();
  });
});

describe('convert and ghostSeries', () => {
  it('converts and keeps the gaps', () => {
    expect(convert([1, null, NaN, 2], (x) => x * 10)).toEqual([10, null, null, 20]);
    expect(convert(undefined, (x) => x)).toEqual([]);
  });

  it('draws the compared run on this clock, grey and unlabelled, or nothing', () => {
    const here = { t: [0, 0.5, 1] };
    const vs = deriveRunData(result());
    const g = ghostSeries('pc', here, vs, (r) => r.cols.pc, (x) => x / 10);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: 'pc_vs', label: '', ghost: true });
    expect(g[0].values[0]).toBeNull();
    expect(ghostSeries('pc', here, null, (r) => r.cols.pc)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the DATA-CONTRACT accessors (contract.ts)

const sl = (over: Partial<ServerLimit> = {}): ServerLimit => ({
  key: 'chug_margin', label: 'Chug margin', value: 1.1, unit: '', limit: 1, warn: 1.2, direction: 'min', grade: 'warn', t_worst: 0.15, index_worst: 5, ...over,
});

describe('contract: result.limits', () => {
  it('takes the server grade, direction and worst moment as given', () => {
    const l = fromServerLimit(sl());
    expect(l.status).toBe('warn');
    expect(l.spec).toMatchObject({ limit: 1, warn: 1.2, direction: 'higher-is-safer' });
    expect(l.worstT).toBe(0.15);
    expect(l.worstWord).toBe('min');
    expect(l.focusKey).toBe('chug');
    expect(l.termKey).toBe('chugMargin');
    expect(l.text(u)).toEqual({ value: '1.10', limit: '≥ 1.00' });
    // A max limit reads "≤" and is "lower is safer"; the server's grade wins over the arithmetic.
    const peak = fromServerLimit(sl({ key: 'ox_tank_mawp', unit: 'psia', value: 950, limit: 1000, warn: 900, direction: 'max', grade: 'bad' }));
    expect(peak.spec.direction).toBe('lower-is-safer');
    expect(peak.status).toBe('bad');
    expect(peak.kind).toBe('pressure');
    expect(peak.text(u).limit).toBe('≤ 1,000\u00a0psia');
  });

  it('reads a unit-free fraction as a percent, "%" as a percent of 100, and other units after the number', () => {
    expect(limitKindOf({ key: 'stiffness_ox', unit: '' }).kind).toBe('percent');
    expect(limitKindOf({ key: 'chug_margin', unit: '' }).kind).toBe('ratio');
    const pct = fromServerLimit(sl({ key: 'regulator_use', unit: '%', value: 96, limit: 100, warn: 90, direction: 'max', grade: 'warn' }));
    expect(pct.value).toBeCloseTo(0.96);
    expect(pct.text(u).value).toBe('96.0\u00a0%');
    const cal = fromServerLimit(sl({ key: 'static_margin_min', unit: 'cal', value: 7.73, limit: 1.5, grade: 'ok' }));
    expect(cal.text(u).value).toBe('7.73\u00a0cal');
    // Max-Q is a dynamic pressure, a difference: psi, never psia.
    const pa = limitKindOf({ key: 'max_q', unit: 'Pa' });
    expect(pa.kind).toBe('pgap');
    expect(pa.toModel(6894.757)).toBeCloseTo(1, 4);
    // The regulator's use of capacity and the engine fit are fractions, shown as percents.
    expect(limitKindOf({ key: 'regulator_wide_open', unit: '' }).kind).toBe('percent');
    expect(limitKindOf({ key: 'engine_fit', unit: '' }).kind).toBe('percent');
  });

  it('counts a graded entry with no red line as a status row, and only "info" stays out of the verdict', () => {
    // The real LE4 he run's propellant check: an amber edge, no red line, graded warn by the server.
    // An amber edge, no red line, graded warn by the server (left-over propellant above 0.2 kg).
    const tie = sl({ key: 'residual', label: 'Propellant left over', unit: 'kg', value: 0.25, limit: null, warn: 0.2, direction: 'max', grade: 'warn', t_worst: 3.45 });
    const ok = sl({ key: 'chug_margin', value: 1.4, grade: 'ok' });
    const withServer = result() as unknown as Record<string, unknown>;
    withServer.limits = [ok, tie, sl({ key: 'max_q', label: 'Max-Q', unit: 'Pa', value: 42923, limit: null, warn: null, direction: 'max', grade: 'info' })];
    const d = deriveRunData(withServer as unknown as LayerXResult);
    expect(d.limits.map((l) => l.key).sort()).toEqual(['chug_margin', 'max_q']);
    expect(d.checks.map((c) => c.key)).toEqual(['residual']);
    expect(d.checks[0].status).toBe('warn');
    expect(d.checks[0].text?.(u)).toEqual({ value: '0.25\u00a0kg', limit: '≤ 0.20\u00a0kg' });
    expect(verdictLine(d.limits, d.checks)).toEqual({ status: 'warn', title: 'Within limits, 1 to check' });
    expect(d.verdict).toBe('warn');
    // The ported checks are the server's to give once it grades the run: none of them is added.
    expect(d.checks.some((c) => c.key === 'leftover' || c.key === 'model' || c.key === 'solver')).toBe(false);
  });

  it('points each server limit at the place its jump rings', () => {
    expect(fromServerLimit(sl({ key: 'tank_cap_ox', unit: 'psia' })).focusKey).toBe('lox_tank');
    expect(fromServerLimit(sl({ key: 'tank_mawp_fuel', unit: 'psi' })).focusKey).toBe('fuel_tank');
    expect(fromServerLimit(sl({ key: 'bottle_margin', unit: 'psi' })).focusKey).toBe('bottle');
    expect(fromServerLimit(sl({ key: 'saturation_OXT.out', unit: 'psi' })).focusKey).toBe('sat-OXT.out');
    expect(fromServerLimit(sl({ key: 'tank_sag', unit: 'psi', series_ref: 'series.fuel.tank_psia' })).focusKey).toBe('fuel_tank');
    expect(fromServerLimit(sl({ key: 'stiffness_fuel_ignition' })).focusKey).toBe('stiff_fuel');
  });

  it('dates a water-hammer limit from its row: the closure for a closing surge, the priming for an opening one', () => {
    const r = result() as unknown as Record<string, unknown>;
    r.limits = [
      sl({ key: 'water_hammer_l_fu1', unit: 'psia', value: 2923, limit: 1015, warn: 812, direction: 'max', grade: 'warn', t_worst: null, index_worst: null }),
      sl({ key: 'water_hammer_l_ox1', unit: 'psia', value: 911, limit: 1015, warn: 812, direction: 'max', grade: 'warn', t_worst: null, index_worst: null }),
    ];
    r.diagnostics = {
      water_hammer: [
        { line: 'l_fu1', side: 'fuel', peak_source: 'closure (Joukowsky value, column separation)', at_s: 3.4346, peak_psia: 2923 },
        { line: 'l_ox1', side: 'ox', peak_source: 'opening', at_s: 3.4346, peak_psia: 911 },
      ],
      start: { available: true, t: [0, 0.1], prime_ox_s: 0.0096, prime_fuel_s: 0.0173 },
    };
    const d = deriveRunData(r as unknown as LayerXResult);
    expect(byKey(d.limits, 'water_hammer_l_fu1').worstT).toBe(3.4346);
    expect(byKey(d.limits, 'water_hammer_l_ox1').worstT).toBe(0.0096);
    expect(byKey(d.limits, 'water_hammer_l_ox1').hint).toMatch(/reaches the injector/);
  });

  it('says in the hover when a new check is capped amber, and which decision it waits on', () => {
    const wh = fromServerLimit(sl({ key: 'cavitation_fuel', unit: '', value: 1.1, limit: 1.2, warn: 1.5, direction: 'min', grade: 'warn', review_pending: true, capped_from: 'bad' }));
    expect(wh.status).toBe('warn');
    expect(wh.reviewPending).toBe(true);
    expect(wh.hint).toMatch(/amber at most until the team reviews/);
    expect(wh.hint).toMatch(/it would be red/);
    expect(fromServerLimit(sl({ decision: 'D7' })).hint).toMatch(/decision D7/);
  });

  it('keeps an "info" limit out of the verdict, and the bars', () => {
    const info = fromServerLimit(sl({ key: 'max_q', label: 'Max-Q', unit: 'Pa', value: 182000, limit: null, grade: 'info' }));
    expect(info.info).toBe(true);
    expect(verdictLine([info], []).title).toBe('Within all 0 limits');
    const bad = fromServerLimit(sl({ grade: 'bad', value: 0.9 }));
    expect(verdictLine([info, bad], []).status).toBe('bad');
  });

  it('prefers the server list, and falls back when there is none or it is empty', () => {
    const ported = deriveRunData(result()).limits;
    expect(limitsOf(result(), ported)).toBe(ported);
    const empty = result() as unknown as Record<string, unknown>;
    empty.limits = [];
    expect(limitsOf(empty as unknown as LayerXResult, ported)).toBe(ported);
    const withServer = result() as unknown as Record<string, unknown>;
    withServer.limits = [sl({ grade: 'bad', value: 0.9 }), { junk: true }];
    const got = serverLimits(withServer as unknown as LayerXResult)!;
    expect(got.map((l) => l.key)).toEqual(['chug_margin']);
    // deriveRunData grades the run on them: one bad limit, the burn fails.
    const d = deriveRunData(withServer as unknown as LayerXResult);
    expect(d.limits.map((l) => l.key)).toEqual(['chug_margin']);
    expect(d.verdict).toBe('bad');
  });
});

describe('contract: blocks', () => {
  const full = () => withContract(result());

  it('drops a failed block and says why', () => {
    const r = withContract(result(), { failed: ['ladder'] });
    expect(diag(r).ladder).toBeUndefined();
    expect(diag(r).regulator).toBeDefined();
    expect(diagMissing(r, 'ladder')).toBe('Not computed: fixture: ladder failed on purpose');
    expect(diagMissing(result(), 'ladder')).toBe('Not computed for this run');
    // A failed diagnostics object as a whole.
    const all = result() as unknown as Record<string, unknown>;
    all.diagnostics = { available: false, error: 'diag crashed\ntrace' };
    expect(diag(all as unknown as LayerXResult)).toEqual({});
    expect(diagMissing(all as unknown as LayerXResult, 'stability')).toBe('Not computed: diag crashed');
  });

  it('reads nothing from an old run', () => {
    const r = result();
    expect(diag(r)).toEqual({});
    expect(networkOf(r)).toBeNull();
    expect(ledgerOf(r)).toBeNull();
    expect(trippedOf(r)).toBeNull();
    expect(testModeOf(r)).toBeNull();
    expect(serverLimits(r)).toBeNull();
  });

  it('reads every block of a full run', () => {
    const r = full();
    const d = diag(r);
    for (const k of ['ladder', 'regulator', 'solenoids', 'pressurant', 'saturation', 'cavitation', 'injector', 'stability', 'hardware',
      'thrust_shape', 'start', 'shutdown', 'water_hammer', 'outflow', 'vv', 'ledger', 'opmap'] as const) expect(d[k], k).toBeDefined();
    expect(networkOf(r)?.t).toEqual(T);
    expect(ledgerOf(r)?.length).toBeGreaterThan(0);
  });

  it('resolves a dotted reference to a column on its own clock', () => {
    const r = full();
    const a = resolveRef(r, 'series.ox.tank_psia');
    expect(a?.t).toEqual(T);
    expect(a?.values[3]).toBe(560);
    const b = resolveRef(r, 'diagnostics.stability.margin');
    expect(b?.t).toBe((diag(r).stability as { t: number[] }).t);
    expect(resolveRef(r, 'diagnostics.nope.margin')).toBeNull();
    expect(resolveRef(r, 'summary.ox')).toBeNull();
    expect(resolveRef(r, null)).toBeNull();
  });

  it('reads flight stability in either shape', () => {
    expect(flightStabilityOf(null)).toBeNull();
    const old = { stability: { static_margin_liftoff_cal: 7.7, min_stability_margin_cal: 7.7 } } as unknown as Parameters<typeof flightStabilityOf>[0];
    expect(flightStabilityOf(old)?.min_stability_margin_cal).toBe(7.7);
  });

  it('fails a run that tripped, whatever its margins say', () => {
    expect(deriveRunData(result()).verdict).not.toBe('bad');
    const r = result() as unknown as Record<string, unknown>;
    r.tripped = { vessel: 'LOX tank', t: 0.2, p_psia: 1100, mawp_psia: 1014.7 };
    expect(deriveRunData(r as unknown as LayerXResult).verdict).toBe('bad');
  });

  it('marks the trip on the timeline as the failure it is, not a warning', () => {
    const ev = timelineEvents([
      { t: 0, kind: 'fire', key: 'fire', label: 'Fire' },
      { t: 0.575, kind: 'fail', key: 'trip', label: 'TK-FUEL tripped at 580.9 psia' },
    ] as unknown as Parameters<typeof timelineEvents>[0], 0.575, []);
    const trip = ev.find((e) => e.key === 'trip')!;
    expect(trip.kind).toBe('trip');
    expect(trip.label).toBe('Trip');
  });

  it('only reads a known test mode and a well-formed trip', () => {
    const r = result() as unknown as Record<string, unknown>;
    r.test_mode = 'coldflow_ln2';
    r.tripped = { vessel: 'LOX tank', t: 1.2, p_psia: 1100, mawp_psia: 1014.7 };
    expect(testModeOf(r as unknown as LayerXResult)).toBe('coldflow_ln2');
    expect(trippedOf(r as unknown as LayerXResult)?.vessel).toBe('LOX tank');
    r.test_mode = 'moon';
    r.tripped = { vessel: 'x' };
    expect(testModeOf(r as unknown as LayerXResult)).toBeNull();
    expect(trippedOf(r as unknown as LayerXResult)).toBeNull();
  });
});

describe('contract: keyed events', () => {
  it('keeps the backend keys, and does not mark burnout or min chug twice', () => {
    const limits = deriveRunData(result()).limits;
    const ev = timelineEvents([
      { t: 0, kind: 't0', label: 'T-0 state', detail: '', key: 't0' },
      { t: 0.15, kind: 'min', label: 'Lowest chug', detail: '', key: 'min_chug' },
      { t: 0.25, kind: 'end', label: 'Burnout', detail: '', key: 'burnout' },
      { t: 0.25, kind: 'end', label: 'Fuel tank dry', detail: '', key: 'dry_fuel' },
      { t: 0.2, kind: 'warn', label: 'Something long happened here', detail: '', key: 'warn:3' },
    ] as unknown as Parameters<typeof timelineEvents>[0], 0.25, limits);
    const keys = ev.map((e) => e.key);
    expect(keys.filter((k) => k.startsWith('burnout'))).toEqual(['burnout']);
    expect(keys.filter((k) => k.includes('chug'))).toEqual(['min_chug']);
    expect(ev.find((e) => e.key === 'dry_fuel')).toMatchObject({ label: 'Fuel dry', kind: 'dry' });
    expect(ev.find((e) => e.key === 'warn:3')?.kind).toBe('warn');
    expect(ev.find((e) => e.key === 'min_chug')?.label).toBe('Min chug');
  });
});

describe('differenceUnit', () => {
  it('drops the datum from a pressure change', () => {
    expect(differenceUnit('psig')).toBe('psi');
    expect(differenceUnit('psia')).toBe('psi');
    expect(differenceUnit('bar(g)')).toBe('bar');
    expect(differenceUnit('kN·s')).toBe('kN·s');
  });
});

describe('runs dry first', () => {
  it('is information even on a run the server graded amber before 2026-10-03', () => {
    const old = { key: 'depletion_tie', label: 'Runs dry first', group: 'propellant', unit: 'kg', value: 0.064, limit: null, warn: 0.33,
                  direction: 'min', grade: 'warn', t_worst: 3.45, index_worst: 80, series_ref: null, basis: '', hint: '' };
    const g = fromServerLimit(old as unknown as Parameters<typeof fromServerLimit>[0]);
    expect(g.info).toBe(true);
    expect(g.status).toBe('ok');
  });
});

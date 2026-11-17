/**
 * ASI physics, engine, twin and checks.
 *
 * The reference numbers are the ASI-1 design point
 * (asi_gox_gch4_17gs_100psia_2026-10-07.yaml), which was worked with CEA and hand
 * calculation, not with this code -- so these hold the twin to the design, not to itself.
 */

import { describe, expect, it } from 'vitest';
import {
  GCH4, GOX, OF_FLAMMABLE, OF_STOICH, PA_PER_PSI, P_ATM, combustion, criticalPressureRatio, orificeMassFlow,
} from '@/lib/asi/physics';
import { DEFAULT_MODEL, autoMapping, cvToCdA_mm2, holeCdA_mm2, mergeSettings, resolveMapping, EMPTY_MAPPING, type AsiModel } from '@/lib/asi/settings';
import { energyMargin, nearestDrill, operatingPoint, sizeAsi } from '@/lib/asi/engine';
import { defaultSequence, failedIgnitionSequence, inputsAt, simulate, subsonicFactor, ventSequence, type SeqEvent } from '@/lib/asi/twin';
import { leakDecay, ofFromPts, reliefCrack, reliefMargin, valveResponse, zeroCheck } from '@/lib/asi/checks';

const psia = (p: number) => p * PA_PER_PSI;

/** Lossless feed: hole P0 = regulator, valves instant -- the design point's own assumption. */
function losslessModel(): AsiModel {
  const line = (l: AsiModel['gox']) => ({ ...l, supplyCdA_mm2: 1000, valveCdA_mm2: 1000, valveOpenMs: 1, valveCloseMs: 1 });
  return { ...DEFAULT_MODEL, gox: line(DEFAULT_MODEL.gox), ch4: line(DEFAULT_MODEL.ch4) };
}

describe('ASI physics against the design point', () => {
  it('choked holes pass the design flows at the design feed pressures', () => {
    // DP: GOX #54 Ø1.397 at 595 psia -> 12.5 g/s; CH4 #59 Ø1.041 at 618 psia -> 5.0 g/s; Cd 0.80.
    const ox = orificeMassFlow(holeCdA_mm2(DEFAULT_MODEL.gox) * 1e-6, psia(595), 293, psia(100), GOX) * 1000;
    const f = orificeMassFlow(holeCdA_mm2(DEFAULT_MODEL.ch4) * 1e-6, psia(618), 293, psia(100), GCH4) * 1000;
    expect(ox).toBeCloseTo(12.5, 0);
    expect(f).toBeCloseTo(5.0, 1);
  });

  it('combustion table reproduces the design point CEA (O/F 2.5)', () => {
    const c = combustion(2.5, psia(110));
    expect(c.cstar).toBeGreaterThan(1878 * 0.99);
    expect(c.cstar).toBeLessThan(1878 * 1.01);
    expect(Math.abs(c.tcK - 3107)).toBeLessThan(40);
  });

  it('flammability window and stoichiometry', () => {
    expect(OF_STOICH).toBeCloseTo(3.99, 2);
    expect(OF_FLAMMABLE.min).toBeCloseTo(1.28, 2);
    expect(OF_FLAMMABLE.max).toBeGreaterThan(30);
  });

  it('subsonic orifice flow joins the choked branch and falls to zero', () => {
    const p0 = psia(100);
    const rc = criticalPressureRatio(GOX.gamma);
    const choked = orificeMassFlow(1e-6, p0, 293, p0 * rc * 0.999, GOX);
    const justSub = orificeMassFlow(1e-6, p0, 293, p0 * rc * 1.001, GOX);
    expect(justSub / choked).toBeGreaterThan(0.999);
    expect(orificeMassFlow(1e-6, p0, 293, p0, GOX)).toBe(0);
    expect(orificeMassFlow(1e-6, p0, 293, p0 * 1.2, GOX)).toBeLessThan(0);
    expect(subsonicFactor(0.3, 1.2)).toBe(1);
    expect(subsonicFactor(0.9, 1.2)).toBeLessThan(1);
  });

  it('Cv 0.2 is ~3.4 mm²', () => {
    expect(cvToCdA_mm2(0.2)).toBeCloseTo(3.4, 1);
  });
});

describe('ASI engine', () => {
  it('lossless operating point is the design point: ~100.6 psia at eta 0.90, O/F 2.5', () => {
    const op = operatingPoint(DEFAULT_MODEL, 580, 603);
    expect(op.pcPsia).toBeGreaterThan(98);
    expect(op.pcPsia).toBeLessThan(103);
    expect(op.of).toBeCloseTo(2.5, 1);
    expect(op.mdotOx_gs + op.mdotF_gs).toBeCloseTo(17.5, 0);
    expect(op.goxHoleChoked && op.ch4HoleChoked).toBe(true);
  });

  it('eta = 1 gives the design point ideal Pc (111.7 psia)', () => {
    const op = operatingPoint({ ...DEFAULT_MODEL, cstarEff: 1 }, 580, 603);
    expect(op.pcPsia).toBeGreaterThan(109.5);
    expect(op.pcPsia).toBeLessThan(114);
  });

  it('sizing the design point picks #54, #59 and the L drill', () => {
    const s = sizeAsi({ pcPsia: 100, of: 2.5, mdotTotal_gs: 17.5, cstarEff: 0.9, goxHolePsia: 595, ch4HolePsia: 618, cd: 0.8 });
    expect(s.goxDrill.name).toBe('#54');
    expect(s.ch4Drill.name).toBe('#59');
    expect(s.throatDrill.name).toBe('L');
    expect(s.warnings.some((w) => w.includes('unchoked'))).toBe(false);
  });

  it('sizing flags unchoked holes and a mixture that will not light', () => {
    const s = sizeAsi({ pcPsia: 400, of: 1.0, mdotTotal_gs: 17.5, cstarEff: 0.9, goxHolePsia: 595, ch4HolePsia: 618, cd: 0.8 });
    expect(s.warnings.some((w) => w.includes('GOx hole unchoked'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('will not light'))).toBe(true);
  });

  it('energy margin matches the design point (3.41 ideal, ~2.8 at eta 0.90)', () => {
    expect(energyMargin(17.5, 1)).toBeCloseTo(3.41, 1);
    expect(energyMargin(17.5, 0.9)).toBeCloseTo(2.76, 1);
  });

  it('nearestDrill', () => {
    expect(nearestDrill(7.4).name).toBe('L');
    expect(nearestDrill(1.18).name).toBe('#56');
  });
});

describe('ASI twin', () => {
  it('lossless nominal light settles on the design point and passes the gate', () => {
    const m = losslessModel();
    const r = simulate(m, defaultSequence(m), 0.4);
    const s = r.summary;
    expect(s.lightS).not.toBeNull();
    expect(s.gate.pass).toBe(true);
    expect(s.steady).not.toBeNull();
    expect(s.steady!.pcPsia).toBeGreaterThan(98);
    expect(s.steady!.pcPsia).toBeLessThan(103);
    expect(s.steady!.of).toBeCloseTo(2.5, 1);
  });

  it('default hardware: lights, passes the gate, drops a little across the run valves', () => {
    const r = simulate(DEFAULT_MODEL, defaultSequence(DEFAULT_MODEL), 1.3);
    const s = r.summary;
    expect(s.gate.pass).toBe(true);
    expect(s.steady!.pcPsia).toBeGreaterThan(85);
    expect(s.steady!.pcPsia).toBeLessThan(101);
    expect(s.steady!.goxDnPsig).toBeLessThan(DEFAULT_MODEL.gox.supplyPsig);
    expect(s.reliefsCracked).toEqual([]);
    // Lights out after the close (tail-off included).
    expect(r.samples[r.samples.length - 1].lit).toBe(false);
  });

  it('no spark, no light: cold flow only', () => {
    const ev = defaultSequence(DEFAULT_MODEL).filter((e) => !e.action.startsWith('SPARK'));
    const r = simulate(DEFAULT_MODEL, ev, 0.5);
    expect(r.summary.lightS).toBeNull();
    expect(r.samples.every((x) => !x.lit)).toBe(true);
    // A cold torch runs at a much lower Pc than a lit one.
    expect(Math.max(...r.samples.map((x) => x.pcPsia))).toBeLessThan(80);
  });

  it('GOx alone never lights (no fuel), however long the spark', () => {
    const ev: SeqEvent[] = [{ t: 0, action: 'SPARK_ON' }, { t: 0, action: 'GOX_OPEN' }];
    const r = simulate(DEFAULT_MODEL, ev, 0.3);
    expect(r.summary.lightS).toBeNull();
  });

  it('a mixture richer than the flammability limit does not light', () => {
    const rich: AsiModel = { ...DEFAULT_MODEL, gox: { ...DEFAULT_MODEL.gox, holeDia_mm: 0.6 } };
    const r = simulate(rich, defaultSequence(rich), 0.3);
    expect(r.summary.lightS).toBeNull();
  });

  it('closing CH4 blows the torch out', () => {
    const ev: SeqEvent[] = [
      { t: 0, action: 'SPARK_ON' }, { t: 0, action: 'GOX_OPEN' }, { t: 0, action: 'CH4_OPEN' },
      { t: 0.2, action: 'SPARK_OFF' }, { t: 0.3, action: 'CH4_CLOSE' },
    ];
    const r = simulate(DEFAULT_MODEL, ev, 1.2);
    expect(r.samples.find((x) => x.t > 0.2)!.lit).toBe(true);
    expect(r.samples[r.samples.length - 1].lit).toBe(false);
    // GOx still flowing at the end.
    expect(r.samples[r.samples.length - 1].mdotOx_gs).toBeGreaterThan(5);
  });

  it('a regulator set above the relief cracks it and the relief flows', () => {
    const hot: AsiModel = { ...DEFAULT_MODEL, gox: { ...DEFAULT_MODEL.gox, supplyPsig: 900 } };
    const r = simulate(hot, [], 0.3);
    expect(r.summary.reliefsCracked.some((x) => x.startsWith('RV-6'))).toBe(true);
    expect(r.samples[r.samples.length - 1].goxReliefGs).toBeGreaterThan(1);
    // A 2 mm² relief against a 10 mm² supply cannot hold the line down: it sits between set and supply.
    const end = r.samples[r.samples.length - 1].goxUpPsig;
    expect(end).toBeGreaterThan(750);
    expect(end).toBeLessThanOrEqual(900);
    // Below its set, nothing relieves.
    const ok = simulate(DEFAULT_MODEL, [], 0.1);
    expect(ok.samples.every((x) => x.goxReliefGs === 0 && x.ch4ReliefGs === 0)).toBe(true);
  });

  it('a relief big enough to hold the line does hold it near set + accumulation', () => {
    const r6 = { ...DEFAULT_MODEL.gox.reliefs[0], fullCdA_mm2: 40 };
    const hot: AsiModel = { ...DEFAULT_MODEL, gox: { ...DEFAULT_MODEL.gox, supplyPsig: 900, reliefs: [r6, DEFAULT_MODEL.gox.reliefs[1]] } };
    const r = simulate(hot, [], 0.5);
    const end = r.samples[r.samples.length - 1].goxUpPsig;
    expect(end).toBeGreaterThan(750);
    expect(end).toBeLessThan(750 * 1.1 + 1);
  });

  it('a slow GOx valve fails the light gate', () => {
    const slow: AsiModel = { ...DEFAULT_MODEL, gox: { ...DEFAULT_MODEL.gox, valveOpenMs: 600 } };
    const r = simulate(slow, defaultSequence(slow), 0.5);
    expect(r.summary.gate.pass).toBe(false);
  });

  it('main-chamber back pressure unchokes the GOx hole (design point: above ~315 psia)', () => {
    const m: AsiModel = { ...losslessModel(), backPressurePsia: 400 };
    const r = simulate(m, defaultSequence(m), 0.4);
    expect(r.summary.steady!.goxHoleChoked).toBe(false);
    expect(r.summary.warnings.some((w) => w.includes('GOx hole unchoked'))).toBe(true);
  });

  it('TC-1 reads copper: it warms tens of degrees per light while the neck heats far faster', () => {
    const r = simulate(DEFAULT_MODEL, defaultSequence(DEFAULT_MODEL), 1.3);
    const s = r.summary;
    expect(s.tcPeakC).toBeGreaterThan(30);
    expect(s.tcPeakC).toBeLessThan(400);
    // Lower neck from the design point's lumped wall: ~930 K/s at first; under the 1100 K limit at the 0.85 s cap.
    expect(s.neckPeakK).toBeGreaterThan(700);
    expect(s.neckPeakK).toBeLessThan(DEFAULT_MODEL.thermal.neckLimitK);
  });

  it('a longer burn takes the neck past its limit and says so', () => {
    const ev = defaultSequence(DEFAULT_MODEL).map((e) => (e.t > 0 ? { ...e, t: 2.5 } : e));
    const r = simulate(DEFAULT_MODEL, ev, 2.6, 2e-3);
    expect(r.summary.neckLimitS).not.toBeNull();
    expect(r.summary.warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });

  it('failed-ignition path never lights', () => {
    const r = simulate(DEFAULT_MODEL, failedIgnitionSequence(), 2.0, 2e-3);
    expect(r.summary.lightS).toBeNull();
  });

  it('vent sequence blows both downstream volumes down to ~0 psig after a run', () => {
    // Pressurise downstream first (run valves open), then safe.
    const ev: SeqEvent[] = [
      { t: 0, action: 'GOX_OPEN' }, { t: 0, action: 'CH4_OPEN' },
      ...ventSequence().map((e) => ({ ...e, t: e.t + 0.3 })),
    ];
    const r = simulate(DEFAULT_MODEL, ev, 2.0, 2e-3);
    const end = r.samples[r.samples.length - 1];
    const mid = r.samples.find((x) => x.t >= 0.29)!;
    expect(mid.goxDnPsig).toBeGreaterThan(300);
    expect(end.goxDnPsig).toBeLessThan(15);
    expect(end.ch4DnPsig).toBeLessThan(15);
    expect(end.goxVentPos).toEqual([1, 1]);
    // The regulator still feeds the upstream vent: it flows, and its node sags below setting.
    expect(end.goxVentGs).toBeGreaterThan(1);
    expect(end.goxUpPsig).toBeLessThan(DEFAULT_MODEL.gox.supplyPsig);
  });

  it('shut vents vent nothing; a vent open during the burn lowers Pc and is flagged', () => {
    const base = simulate(DEFAULT_MODEL, defaultSequence(DEFAULT_MODEL), 0.5);
    expect(base.samples.every((x) => x.goxVentGs === 0 && x.ch4VentGs === 0)).toBe(true);
    const leaky = simulate(DEFAULT_MODEL, [...defaultSequence(DEFAULT_MODEL), { t: 0, action: 'GOX_VENT_DN_OPEN' }], 0.5);
    expect(leaky.summary.steady!.pcPsia).toBeLessThan(base.summary.steady!.pcPsia - 5);
    expect(leaky.summary.warnings.some((w) => w.includes('vent solenoid is open'))).toBe(true);
  });

  it('inputsAt applies events in time order', () => {
    const ev: SeqEvent[] = [{ t: 0.5, action: 'GOX_CLOSE' }, { t: 0, action: 'GOX_OPEN' }];
    expect(inputsAt(ev, 0.1).goxOpen).toBe(true);
    expect(inputsAt(ev, 0.6).goxOpen).toBe(false);
  });
});

describe('ASI checks', () => {
  it('zero, leak, relief', () => {
    expect(zeroCheck(3, 5).verdict).toBe('pass');
    expect(zeroCheck(8, 5).verdict).toBe('fail');
    expect(zeroCheck(null, 5).verdict).toBe('fail');
    expect(leakDecay(630, 629, 60, 2).verdict).toBe('pass');
    expect(leakDecay(630, 620, 60, 2).verdict).toBe('fail');
    expect(leakDecay(630, 640, 60, 2).verdict).toBe('warn');
    expect(reliefCrack(740, 750, 5).verdict).toBe('pass');
    expect(reliefCrack(650, 750, 5).verdict).toBe('fail');
    expect(reliefMargin(700, 750).status).toBe('warn');
    expect(reliefMargin(500, 750).status).toBe('ok');
    expect(reliefMargin(800, 750).status).toBe('over');
  });

  it('valve response finds the 90 % crossing', () => {
    const s = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.01, v: i * 0.01 < 0.1 ? 0 : 500 * Math.min(1, (i * 0.01 - 0.1) / 0.05) }));
    const r = valveResponse(s, 0);
    expect(r.ms).not.toBeNull();
    expect(r.ms!).toBeGreaterThanOrEqual(140);
    expect(r.ms!).toBeLessThanOrEqual(150);
    expect(valveResponse(s.map((x) => ({ ...x, v: 1 })), 0).ms).toBeNull();
  });

  it('O/F from the hole PTs at the design feed is ~2.5', () => {
    const d = ofFromPts(DEFAULT_MODEL, 580, 603);
    expect(d.of).toBeCloseTo(2.5, 1);
    expect(d.lightable).toBe(true);
  });
});

describe('ASI settings', () => {
  it('auto-maps P&ID tags and descriptive names; explicit wins', () => {
    const a = autoMapping(['PT-LP-5', 'PT LP 2', 'Methane Upstream', 'CH4 Downstream', 'Fuel Upstream'], ['ASI TC', 'Chamber Mid TC 1'], ['ASI GOx Valve', 'ASI CH4 Valve', 'Spark', 'Fuel Main']);
    expect(a.goxUp).toBe('PT-LP-5');
    expect(a.goxDn).toBe('PT LP 2');
    expect(a.ch4Up).toBe('Methane Upstream');
    expect(a.ch4Dn).toBe('CH4 Downstream');
    expect(a.tc).toBe('ASI TC');
    expect(a.goxValve).toBe('ASI GOx Valve');
    expect(a.ch4Valve).toBe('ASI CH4 Valve');
    expect(a.spark).toBe('Spark');
    expect(resolveMapping({ ...EMPTY_MAPPING, goxUp: 'X' }, a).goxUp).toBe('X');
  });

  it('maps the LabJack T7 roles in config/profiles/default (AIN0-3)', () => {
    const roles = ['PT-LP-5 GOx Upstream', 'PT-LP-2 GOx Downstream', 'PT-LP-6 CH4 Upstream', 'PT-LP-1 CH4 Downstream', 'Fuel Upstream', 'Ox Downstream'];
    const a = autoMapping(roles, [], []);
    expect(a.goxUp).toBe('PT-LP-5 GOx Upstream');
    expect(a.goxDn).toBe('PT-LP-2 GOx Downstream');
    expect(a.ch4Up).toBe('PT-LP-6 CH4 Upstream');
    expect(a.ch4Dn).toBe('PT-LP-1 CH4 Downstream');
  });

  it('maps the ASI PDB roles: run valves and vents never confused', () => {
    const acts = ['LOX Main', 'Fuel Vent', 'ASI GOx Vent Up', 'ASI GOx Vent Dn', 'ASI GOx Run', 'ASI CH4 Vent Up', 'ASI CH4 Vent Dn', 'ASI CH4 Run'];
    const a = autoMapping([], [], acts);
    expect(a.goxValve).toBe('ASI GOx Run');
    expect(a.ch4Valve).toBe('ASI CH4 Run');
    expect(a.goxVentUp).toBe('ASI GOx Vent Up');
    expect(a.goxVentDn).toBe('ASI GOx Vent Dn');
    expect(a.ch4VentUp).toBe('ASI CH4 Vent Up');
    expect(a.ch4VentDn).toBe('ASI CH4 Vent Dn');
  });

  it('default vents follow the operator wiring (PDB 1/2/3 GOx, 4/5/6 CH4)', () => {
    expect(DEFAULT_MODEL.gox.vents.map((v) => [v.connector, v.location])).toEqual([[1, 'upstream'], [2, 'downstream']]);
    expect(DEFAULT_MODEL.gox.valveConnector).toBe(3);
    expect(DEFAULT_MODEL.ch4.vents.map((v) => [v.connector, v.location])).toEqual([[4, 'upstream'], [5, 'downstream']]);
    expect(DEFAULT_MODEL.ch4.valveConnector).toBe(6);
  });

  it('does not mistake the main engine for the ASI', () => {
    const a = autoMapping(['Fuel Upstream', 'Ox Upstream', 'Ox Downstream'], ['Chamber Mid TC 1'], ['Fuel Main', 'LOX Main']);
    expect(a.ch4Up).toBe('');
    expect(a.tc).toBe('');
    expect(a.goxValve).toBe('');
  });

  it('merges an older stored copy with the defaults', () => {
    const s = mergeSettings({ model: { gox: { supplyPsig: 500 } } as unknown as AsiModel });
    expect(s.model.gox.supplyPsig).toBe(500);
    expect(s.model.gox.holeDia_mm).toBe(DEFAULT_MODEL.gox.holeDia_mm);
    expect(s.model.gox.reliefs[0].name).toBe('RV-6');
    expect(s.model.thermal.neckLimitK).toBe(1100);
  });

  it('P_ATM sanity', () => {
    expect(P_ATM / PA_PER_PSI).toBeCloseTo(14.696, 2);
  });
});

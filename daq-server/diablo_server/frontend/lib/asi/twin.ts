/**
 * ASI twin: the two feed lines, the torch chamber and its copper, in time.
 *
 * Per line (P&ID ASI V1):
 *
 *   regulator ──[supply CdA]──► U ──[run valve]──► D ──(check valve)──[hole]──► chamber ──[throat]──► back pressure
 *                               │ PT up, relief        │ PT down, relief
 *
 * U and D are isothermal ideal-gas volumes (dp/dt = R T / V * net mdot), stepped
 * linearly-implicitly in their own pressure so a near-balanced orifice (whose
 * subsonic slope is unbounded at dp -> 0) cannot ring. The chamber holds ~7 cm^3
 * and fills in well under a millisecond, so it is not a volume: each step its
 * pressure is SOLVED -- what the two holes deliver equals what the throat passes,
 * bracketed and bisected (the root is unique: inflow falls and outflow rises with Pc).
 * The check valves between run valve and QD stop the chamber backing gas into a line.
 *
 * Burning: lit when the spark is on and both gases flow inside the O/F window;
 * blown out when either stops or the mixture leaves it. Throat flow is
 * Pc At / (eta c*) with the equilibrium table's c*, times the subsonic factor once
 * the back pressure (main chamber, in the engine) unchokes it.
 *
 * Walls: TC-1 sits 1 mm from the bore in the Ø50 copper body, so it is a 1-D
 * conduction problem (flux in at the bore, adiabatic at the lumped outer
 * thickness) read 1 mm in, then lagged by the probe. The lower neck is the design
 * point's lumped wall. Film coefficients scale with mdot^0.8 (Bartz, as the design
 * point does) and drive (eta^2 Tc - T_wall).
 */

import {
  GCH4, GOX, P_ATM, PA_PER_PSI, R_UNIVERSAL, ccToM3, coldMixture, combustion, criticalPressureRatio,
  cstarOf, mm2ToM2, orificeMassFlow, paToPsia, type IdealGas,
} from './physics';
import { holeCdA_mm2, type AsiModel, type LineConfig, type LineId } from './settings';

export interface TwinInputs {
  goxOpen: boolean;
  ch4Open: boolean;
  spark: boolean;
  /** Live mode: drive the upstream node from a measured pressure (Pa abs) instead of the regulator. */
  goxUpPa?: number | null;
  ch4UpPa?: number | null;
  /** Vent solenoids commanded open, [before run valve, after run valve]. Absent = shut. */
  goxVents?: [boolean, boolean];
  ch4Vents?: [boolean, boolean];
}

interface LineState {
  pUp: number;
  pDn: number;
  /** Run valve position, 0 shut .. 1 open. */
  pos: number;
  mInj: number;
  mRelief: [number, number];
  /** Vent solenoid positions, 0 shut .. 1 open. */
  ventPos: [number, number];
  mVent: [number, number];
}

export interface TwinSample {
  t: number;
  goxUpPsig: number; goxDnPsig: number; ch4UpPsig: number; ch4DnPsig: number;
  goxPos: number; ch4Pos: number;
  pcPsia: number;
  of: number;
  mdotOx_gs: number; mdotF_gs: number;
  lit: boolean;
  spark: boolean;
  /** TC-1 reading, degC. */
  tcC: number;
  /** Bore surface at the TC station, degC. */
  boreC: number;
  /** Lower neck (lumped), K. */
  neckK: number;
  /** Total relief flow per line, g/s. */
  goxReliefGs: number; ch4ReliefGs: number;
  /** Total vent-solenoid flow per line, g/s. */
  goxVentGs: number; ch4VentGs: number;
  goxVentPos: [number, number]; ch4VentPos: [number, number];
  goxHoleChoked: boolean; ch4HoleChoked: boolean; throatChoked: boolean;
}

/** Numerical step for the gas side, s. */
export const TWIN_DT = 2e-5;
/** Conduction grid in the TC body, m. */
const WALL_DX = 2.5e-4;
/** Below this a propellant is "not flowing" for ignition, kg/s. */
const MDOT_EPS = 1e-4;

/** Subsonic flow as a fraction of choked flow at the same upstream state. */
export function subsonicFactor(pbOverP0: number, gamma: number): number {
  const rc = criticalPressureRatio(gamma);
  if (pbOverP0 <= rc) return 1;
  if (pbOverP0 >= 1) return 0;
  const g = gamma;
  const choked = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  const sub = Math.sqrt(((2 * g) / (g - 1)) * (Math.pow(pbOverP0, 2 / g) - Math.pow(pbOverP0, (g + 1) / g)));
  return sub / choked;
}

/**
 * Orifice flow made linear over the last 0.1 % of pressure difference, so dm/dp
 * stays finite at balance (the bare formula goes as sqrt(dp)). Changes no flow
 * that matters: at dp = 0.1 % of p0 it is already ~5 % of choked.
 */
function smoothFlow(cda: number, p0: number, t0: number, pb: number, gas: IdealGas): number {
  if (pb > p0) return -smoothFlow(cda, pb, t0, p0, gas);
  const delta = 1e-3;
  if (pb / p0 <= 1 - delta) return orificeMassFlow(cda, p0, t0, pb, gas);
  const edge = orificeMassFlow(cda, p0, t0, p0 * (1 - delta), gas);
  return (edge * (p0 - pb)) / (p0 * delta);
}

const lineGas = (id: LineId): IdealGas => (id === 'gox' ? GOX : GCH4);

export class AsiTwin {
  readonly model: AsiModel;
  t = 0;
  lit = false;
  spark = false;
  pc: number;
  of = 0;
  lines: Record<LineId, LineState>;
  /** Copper temperatures across the TC station, K; [0] is the bore surface. */
  wall: Float64Array;
  neckK: number;
  tcK: number;
  private wallClock = 0;
  private wallScratch = new Float64Array(0);
  private readonly pb: number;
  private readonly pAmb = P_ATM;
  private readonly at: number;
  private readonly tcNode: number;

  constructor(model: AsiModel) {
    this.model = model;
    this.pb = model.backPressurePsia * PA_PER_PSI;
    this.at = Math.PI * Math.pow(model.throatDia_mm / 2000, 2);
    this.pc = this.pb;
    const fresh = (l: LineConfig): LineState => ({
      pUp: l.supplyPsig * PA_PER_PSI + this.pAmb,
      pDn: this.pAmb,
      pos: 0,
      mInj: 0,
      mRelief: [0, 0],
      ventPos: [0, 0],
      mVent: [0, 0],
    });
    this.lines = { gox: fresh(model.gox), ch4: fresh(model.ch4) };
    const n = Math.max(3, Math.round((model.thermal.bodyTEff_mm / 1000) / WALL_DX) + 1);
    const t0 = model.gox.gasTempK;
    this.wall = new Float64Array(n).fill(t0);
    this.neckK = t0;
    this.tcK = t0;
    this.tcNode = Math.min(n - 1, Math.round((model.thermal.tcDepth_mm / 1000) / WALL_DX));
  }

  /** Put both downstream nodes at a pressure (Pa abs), e.g. a trapped charge. */
  setDownstream(pa: number): void {
    this.lines.gox.pDn = pa;
    this.lines.ch4.pDn = pa;
  }

  private holeFlow(id: LineId, pDn: number, pc: number): number {
    const l = this.model[id];
    return Math.max(0, orificeMassFlow(mm2ToM2(holeCdA_mm2(l)), pDn, l.gasTempK, pc, lineGas(id)));
  }

  /** Throat flow at chamber pressure pc for the given inflows. */
  private throatFlow(pc: number, mOx: number, mF: number, lit: boolean): number {
    if (pc <= this.pb) return 0;
    if (lit) {
      const of = mF > 0 ? mOx / mF : this.model.ofMax;
      const c = combustion(of, pc);
      return ((pc * this.at) / (this.model.cstarEff * c.cstar)) * subsonicFactor(this.pb / pc, c.gamma);
    }
    const mix = coldMixture(mOx, mF);
    const t0 = this.model.gox.gasTempK;
    return ((pc * this.at) / cstarOf(mix, t0)) * subsonicFactor(this.pb / pc, mix.gamma);
  }

  /** Solve the chamber for the current downstream pressures. */
  solveChamber(pDnOx: number, pDnF: number, lit: boolean): { pc: number; mOx: number; mF: number } {
    const lo0 = this.pb;
    const hi0 = Math.max(pDnOx, pDnF, this.pb);
    const resid = (pc: number) => {
      const mOx = this.holeFlow('gox', pDnOx, pc);
      const mF = this.holeFlow('ch4', pDnF, pc);
      return { r: mOx + mF - this.throatFlow(pc, mOx, mF, lit), mOx, mF };
    };
    if (hi0 - lo0 < 1) {
      const z = resid(lo0);
      return { pc: lo0, mOx: z.mOx, mF: z.mF };
    }
    let lo = lo0;
    let hi = hi0;
    for (let i = 0; i < 48 && hi - lo > 1; i++) {
      const mid = 0.5 * (lo + hi);
      if (resid(mid).r > 0) lo = mid; else hi = mid;
    }
    const pc = 0.5 * (lo + hi);
    const z = resid(pc);
    return { pc, mOx: z.mOx, mF: z.mF };
  }

  private reliefFlows(l: LineConfig, gas: IdealGas, pUp: number, pDn: number): [number, number] {
    return l.reliefs.map((r) => {
      const p = r.location === 'upstream' ? pUp : pDn;
      const pg = (p - this.pAmb) / PA_PER_PSI;
      const span = Math.max(1e-6, (r.setPsig * r.accumulationPct) / 100);
      const frac = Math.min(1, Math.max(0, (pg - r.setPsig) / span));
      return frac > 0 ? Math.max(0, orificeMassFlow(mm2ToM2(r.fullCdA_mm2 * frac), p, l.gasTempK, this.pAmb, gas)) : 0;
    }) as [number, number];
  }

  /** One gas-side step of `dt` seconds. */
  step(dt: number, inp: TwinInputs): void {
    this.spark = inp.spark;
    const sol = this.solveChamber(this.lines.gox.pDn, this.lines.ch4.pDn, this.lit);
    this.pc = sol.pc;
    this.lines.gox.mInj = sol.mOx;
    this.lines.ch4.mInj = sol.mF;
    this.of = sol.mF > 0 ? sol.mOx / sol.mF : sol.mOx > 0 ? Infinity : 0;

    const flowing = sol.mOx > MDOT_EPS && sol.mF > MDOT_EPS
      && this.of >= this.model.ofMin && this.of <= this.model.ofMax;
    if (!this.lit && inp.spark && flowing) this.lit = true;
    else if (this.lit && !flowing) this.lit = false;

    for (const id of ['gox', 'ch4'] as const) {
      const l = this.model[id];
      const s = this.lines[id];
      const gas = lineGas(id);
      const T = l.gasTempK;
      const open = id === 'gox' ? inp.goxOpen : inp.ch4Open;
      const stroke = (open ? l.valveOpenMs : l.valveCloseMs) / 1000;
      s.pos = Math.min(1, Math.max(0, s.pos + (open ? 1 : -1) * (stroke > 0 ? dt / stroke : 1)));

      const pSup = l.supplyPsig * PA_PER_PSI + this.pAmb;
      const cdaSup = mm2ToM2(l.supplyCdA_mm2);
      const cdaValve = mm2ToM2(l.valveCdA_mm2 * s.pos);
      const override = id === 'gox' ? inp.goxUpPa : inp.ch4UpPa;
      s.mRelief = this.reliefFlows(l, gas, s.pUp, s.pDn);
      const ventCmd = (id === 'gox' ? inp.goxVents : inp.ch4Vents) ?? [false, false];
      l.vents.forEach((v, i) => {
        const st = (ventCmd[i] ? v.openMs : v.closeMs) / 1000;
        s.ventPos[i] = Math.min(1, Math.max(0, s.ventPos[i] + (ventCmd[i] ? 1 : -1) * (st > 0 ? dt / st : 1)));
      });
      const ventAt = (loc: 'upstream' | 'downstream', p: number) => l.vents.reduce((a, v, i) => a
        + (v.location === loc && s.ventPos[i] > 0 ? Math.max(0, smoothFlow(mm2ToM2(v.cdA_mm2 * s.ventPos[i]), p, T, this.pAmb, gas)) : 0), 0);
      s.mVent = l.vents.map((v, i) => (s.ventPos[i] > 0
        ? Math.max(0, smoothFlow(mm2ToM2(v.cdA_mm2 * s.ventPos[i]), v.location === 'upstream' ? s.pUp : s.pDn, T, this.pAmb, gas))
        : 0)) as [number, number];

      // Upstream node: regulator in (it never back-flows), valve and its relief out.
      const kUp = (gas.R * T) / ccToM3(l.upstreamVolume_cc);
      const reliefAt = (loc: 'upstream' | 'downstream', pu: number, pd: number) =>
        this.reliefFlows(l, gas, pu, pd).reduce((a, m, i) => a + (l.reliefs[i].location === loc ? m : 0), 0);
      const netUp = (pu: number) => Math.max(0, smoothFlow(cdaSup, pSup, T, pu, gas))
        - smoothFlow(cdaValve, pu, T, s.pDn, gas)
        - reliefAt('upstream', pu, s.pDn)
        - ventAt('upstream', pu);
      // Downstream node: valve in, hole (at the solved Pc) and its relief out.
      const kDn = (gas.R * T) / ccToM3(l.downstreamVolume_cc);
      const netDn = (pd: number) => smoothFlow(cdaValve, s.pUp, T, pd, gas)
        - this.holeFlow(id, pd, this.pc)
        - reliefAt('downstream', s.pUp, pd)
        - ventAt('downstream', pd);

      const newUp = override != null && Number.isFinite(override)
        ? override
        : implicitStep(s.pUp, dt, (p) => kUp * netUp(p));
      const newDn = implicitStep(s.pDn, dt, (p) => kDn * netDn(p));
      s.pUp = Math.max(1000, newUp);
      s.pDn = Math.max(1000, newDn);
    }

    this.stepWalls(dt, sol.mOx + sol.mF);
    this.t += dt;
  }

  /** Effective hot-gas temperature driving the walls, K. */
  gasTempK(): number {
    if (!this.lit) return this.model.gox.gasTempK;
    return this.model.cstarEff ** 2 * combustion(this.of, this.pc).tcK;
  }

  private stepWalls(dt: number, mdot: number): void {
    const th = this.model.thermal;
    const scale = mdot > 0 ? Math.pow(mdot / (th.mdotRef_gs / 1000), 0.8) : 0;
    const taw = this.gasTempK();
    const rc = th.rhoCp_MJ * 1e6;
    // Lower neck, lumped.
    this.neckK += (dt * th.hThroat * scale * (taw - this.neckK)) / (rc * (th.neckTEff_mm / 1000));
    // TC station, 1-D conduction on its own stable clock.
    const alpha = th.wallK / rc;
    const dtc = (0.4 * WALL_DX * WALL_DX) / alpha;
    this.wallClock += dt;
    const w = this.wall;
    const n = w.length;
    const next = this.wallScratch.length === n ? this.wallScratch : (this.wallScratch = new Float64Array(n));
    const k = (alpha * dtc) / (WALL_DX * WALL_DX);
    while (this.wallClock >= dtc) {
      this.wallClock -= dtc;
      // Bore: half cell, flux in. Inside: FTCS. Outer face: adiabatic (mirror node).
      const q = th.hChamber * scale * (taw - w[0]);
      next[0] = w[0] + (dtc * (q + (th.wallK * (w[1] - w[0])) / WALL_DX)) / (rc * WALL_DX * 0.5);
      for (let i = 1; i < n - 1; i++) next[i] = w[i] + k * (w[i - 1] - 2 * w[i] + w[i + 1]);
      next[n - 1] = w[n - 1] + 2 * k * (w[n - 2] - w[n - 1]);
      w.set(next);
    }
    this.tcK += (dt * (this.wall[this.tcNode] - this.tcK)) / Math.max(1e-3, th.tcTauS);
  }

  /** Step forward `duration` seconds at the twin's own numerical step. */
  advance(duration: number, inp: TwinInputs): void {
    let left = duration;
    while (left > 1e-12) {
      const h = Math.min(TWIN_DT, left);
      this.step(h, inp);
      left -= h;
    }
  }

  sample(): TwinSample {
    const g = this.lines.gox;
    const c = this.lines.ch4;
    const psig = (p: number) => (p - this.pAmb) / PA_PER_PSI;
    const crit = (gas: IdealGas) => criticalPressureRatio(gas.gamma);
    const throatGamma = this.lit ? combustion(this.of, this.pc).gamma : coldMixture(g.mInj, c.mInj).gamma;
    return {
      t: this.t,
      goxUpPsig: psig(g.pUp), goxDnPsig: psig(g.pDn), ch4UpPsig: psig(c.pUp), ch4DnPsig: psig(c.pDn),
      goxPos: g.pos, ch4Pos: c.pos,
      pcPsia: paToPsia(this.pc),
      of: Number.isFinite(this.of) ? this.of : NaN,
      mdotOx_gs: g.mInj * 1000, mdotF_gs: c.mInj * 1000,
      lit: this.lit, spark: this.spark,
      tcC: this.tcK - 273.15,
      boreC: this.wall[0] - 273.15,
      neckK: this.neckK,
      goxReliefGs: (g.mRelief[0] + g.mRelief[1]) * 1000,
      ch4ReliefGs: (c.mRelief[0] + c.mRelief[1]) * 1000,
      goxVentGs: (g.mVent[0] + g.mVent[1]) * 1000,
      ch4VentGs: (c.mVent[0] + c.mVent[1]) * 1000,
      goxVentPos: [g.ventPos[0], g.ventPos[1]],
      ch4VentPos: [c.ventPos[0], c.ventPos[1]],
      goxHoleChoked: g.mInj > 0 && this.pc / g.pDn <= crit(GOX),
      ch4HoleChoked: c.mInj > 0 && this.pc / c.pDn <= crit(GCH4),
      throatChoked: this.pc > this.pb && this.pb / this.pc <= crit({ name: '', gamma: throatGamma, R: R_UNIVERSAL / 20 }),
    };
  }
}

/** Linearly-implicit Euler on one pressure: p' = f(p). */
function implicitStep(p: number, dt: number, f: (p: number) => number): number {
  const f0 = f(p);
  const h = Math.max(1, p * 1e-6);
  const dfdp = (f(p + h) - f0) / h;
  const denom = 1 - dt * Math.min(0, dfdp);
  return p + (dt * f0) / denom;
}

// ── Sequences ────────────────────────────────────────────────────────────────

export type SeqAction = 'GOX_OPEN' | 'GOX_CLOSE' | 'CH4_OPEN' | 'CH4_CLOSE' | 'SPARK_ON' | 'SPARK_OFF'
  | 'GOX_VENT_UP_OPEN' | 'GOX_VENT_UP_CLOSE' | 'GOX_VENT_DN_OPEN' | 'GOX_VENT_DN_CLOSE'
  | 'CH4_VENT_UP_OPEN' | 'CH4_VENT_UP_CLOSE' | 'CH4_VENT_DN_OPEN' | 'CH4_VENT_DN_CLOSE';

export interface SeqEvent {
  t: number;
  action: SeqAction;
}

export const SEQ_ACTIONS: SeqAction[] = [
  'SPARK_ON', 'GOX_OPEN', 'CH4_OPEN', 'CH4_CLOSE', 'GOX_CLOSE', 'SPARK_OFF',
  'GOX_VENT_UP_OPEN', 'GOX_VENT_UP_CLOSE', 'GOX_VENT_DN_OPEN', 'GOX_VENT_DN_CLOSE',
  'CH4_VENT_UP_OPEN', 'CH4_VENT_UP_CLOSE', 'CH4_VENT_DN_OPEN', 'CH4_VENT_DN_CLOSE',
];

/**
 * Safing after a run: run valves shut, then every vent opened so both lines blow
 * down to atmosphere (the regulators keep feeding the upstream vents until isolated).
 */
export function ventSequence(): SeqEvent[] {
  return [
    { t: 0, action: 'GOX_CLOSE' }, { t: 0, action: 'CH4_CLOSE' }, { t: 0, action: 'SPARK_OFF' },
    { t: 0.1, action: 'GOX_VENT_DN_OPEN' }, { t: 0.1, action: 'CH4_VENT_DN_OPEN' },
    { t: 0.1, action: 'GOX_VENT_UP_OPEN' }, { t: 0.1, action: 'CH4_VENT_UP_OPEN' },
  ];
}

/** The design point's nominal light: spark and both ASI valves together, off at the 0.85 s cap. */
export function defaultSequence(model: AsiModel): SeqEvent[] {
  const cap = model.burnCapS;
  return [
    { t: 0, action: 'SPARK_ON' },
    { t: 0, action: 'GOX_OPEN' },
    { t: 0, action: 'CH4_OPEN' },
    { t: cap, action: 'CH4_CLOSE' },
    { t: cap, action: 'SPARK_OFF' },
    { t: cap, action: 'GOX_CLOSE' },
  ];
}

/** The design point's failed-ignition path: spark off, CH4 off, GOx flush, GOx off. */
export function failedIgnitionSequence(): SeqEvent[] {
  return [
    { t: 0, action: 'GOX_OPEN' },
    { t: 0, action: 'CH4_OPEN' },
    { t: 0.25, action: 'CH4_CLOSE' },
    { t: 1.75, action: 'GOX_CLOSE' },
  ];
}

export function inputsAt(events: SeqEvent[], t: number): TwinInputs {
  const st: TwinInputs = { goxOpen: false, ch4Open: false, spark: false, goxVents: [false, false], ch4Vents: [false, false] };
  const gv = st.goxVents!;
  const cv = st.ch4Vents!;
  [...events].sort((a, b) => a.t - b.t).forEach((e) => {
    if (e.t > t + 1e-12) return;
    if (e.action === 'GOX_OPEN') st.goxOpen = true;
    if (e.action === 'GOX_CLOSE') st.goxOpen = false;
    if (e.action === 'CH4_OPEN') st.ch4Open = true;
    if (e.action === 'CH4_CLOSE') st.ch4Open = false;
    if (e.action === 'SPARK_ON') st.spark = true;
    if (e.action === 'SPARK_OFF') st.spark = false;
    if (e.action === 'GOX_VENT_UP_OPEN') gv[0] = true;
    if (e.action === 'GOX_VENT_UP_CLOSE') gv[0] = false;
    if (e.action === 'GOX_VENT_DN_OPEN') gv[1] = true;
    if (e.action === 'GOX_VENT_DN_CLOSE') gv[1] = false;
    if (e.action === 'CH4_VENT_UP_OPEN') cv[0] = true;
    if (e.action === 'CH4_VENT_UP_CLOSE') cv[0] = false;
    if (e.action === 'CH4_VENT_DN_OPEN') cv[1] = true;
    if (e.action === 'CH4_VENT_DN_CLOSE') cv[1] = false;
  });
  return st;
}

// ── A whole run ──────────────────────────────────────────────────────────────

export interface RunSummary {
  lightS: number | null;
  /** Total lit time, s, including the tail-off. */
  burnS: number;
  /** Lit time after the first close command, s. */
  tailS: number;
  gate: { pass: boolean; pcAtGatePsia: number };
  steady: TwinSample | null;
  peakPsig: Record<'goxUp' | 'goxDn' | 'ch4Up' | 'ch4Dn', number>;
  reliefsCracked: string[];
  tcPeakC: number;
  borePeakC: number;
  neckPeakK: number;
  /** From light, s; null if the neck never reached its limit. */
  neckLimitS: number | null;
  warnings: string[];
}

export interface RunResult {
  samples: TwinSample[];
  summary: RunSummary;
}

/**
 * Run a sequence for `durationS` seconds from a pressurised, shut stand
 * (regulators at setting, downstream vented), sampling every `sampleS`.
 */
export function simulate(model: AsiModel, events: SeqEvent[], durationS: number, sampleS = 1e-3): RunResult {
  const tw = new AsiTwin(model);
  const samples: TwinSample[] = [tw.sample()];
  const times = [...new Set(events.map((e) => e.t))].filter((t) => t > 0 && t < durationS);
  let nextSample = sampleS;
  while (tw.t < durationS - 1e-12) {
    const inp = inputsAt(events, tw.t);
    // Land exactly on events and samples so a valve opens when it is told to.
    const nextEvent = times.find((t) => t > tw.t + 1e-12) ?? durationS;
    const h = Math.min(TWIN_DT, nextEvent - tw.t, nextSample - tw.t, durationS - tw.t);
    tw.step(Math.max(h, 1e-9), inp);
    if (tw.t >= nextSample - 1e-12) {
      samples.push(tw.sample());
      nextSample += sampleS;
    }
  }
  return { samples, summary: summarize(model, events, samples) };
}

export function summarize(model: AsiModel, events: SeqEvent[], samples: TwinSample[]): RunSummary {
  const warnings: string[] = [];
  const firstOpen = Math.min(
    ...events.filter((e) => e.action === 'GOX_OPEN' || e.action === 'CH4_OPEN').map((e) => e.t), Infinity,
  );
  const lightSample = samples.find((s) => s.lit);
  const lightS = lightSample ? lightSample.t : null;
  const dtS = samples.length > 1 ? samples[1].t - samples[0].t : 0;
  const burnS = samples.filter((s) => s.lit).length * dtS;

  const gateT = (Number.isFinite(firstOpen) ? firstOpen : 0) + model.gateMs / 1000;
  const pcAtGate = Math.max(0, ...samples.filter((s) => s.t <= gateT + 1e-9).map((s) => s.pcPsia));
  const gate = { pass: pcAtGate >= model.gatePcPsia, pcAtGatePsia: pcAtGate };

  // Steady state: the last lit sample before the first close after light.
  let steady: TwinSample | null = null;
  if (lightS !== null) {
    const firstClose = Math.min(
      ...events.filter((e) => (e.action === 'GOX_CLOSE' || e.action === 'CH4_CLOSE') && e.t > lightS).map((e) => e.t),
      samples[samples.length - 1].t,
    );
    const before = samples.filter((s) => s.lit && s.t < firstClose - 1e-9);
    steady = before.length ? before[before.length - 1] : null;
  }

  const peak = (k: keyof TwinSample) => Math.max(...samples.map((s) => s[k] as number));
  const peakPsig = { goxUp: peak('goxUpPsig'), goxDn: peak('goxDnPsig'), ch4Up: peak('ch4UpPsig'), ch4Dn: peak('ch4DnPsig') };
  const reliefsCracked: string[] = [];
  (['gox', 'ch4'] as const).forEach((id) => {
    model[id].reliefs.forEach((r) => {
      const p = r.location === 'upstream' ? peakPsig[`${id}Up` as const] : peakPsig[`${id}Dn` as const];
      if (p > r.setPsig) reliefsCracked.push(`${r.name} (${p.toFixed(0)} psig > set ${r.setPsig})`);
    });
  });
  const neckSample = lightS !== null ? samples.find((s) => s.neckK >= model.thermal.neckLimitK) : undefined;
  const neckLimitS = neckSample && lightS !== null ? neckSample.t - lightS : null;

  if (lightS === null) {
    const anySpark = events.some((e) => e.action === 'SPARK_ON');
    warnings.push(anySpark ? 'No light: the mixture never reached the O/F window with both gases flowing.' : 'No spark in the sequence: cold flow only.');
  }
  if (lightS !== null && !gate.pass) warnings.push(`Light gate fails: Pc ${pcAtGate.toFixed(0)} psia < ${model.gatePcPsia} psia within ${model.gateMs} ms -> abort.`);
  // Commanded burn: light to the first close. What burns after it is the
  // downstream volumes bleeding through the holes, reported on its own.
  const closeAfterLight = lightS === null ? null : Math.min(
    ...events.filter((e) => (e.action === 'GOX_CLOSE' || e.action === 'CH4_CLOSE') && e.t >= lightS - 1e-9).map((e) => e.t),
    Infinity,
  );
  const tailS = closeAfterLight !== null && Number.isFinite(closeAfterLight)
    ? samples.filter((s) => s.lit && s.t > closeAfterLight).length * dtS : 0;
  if (burnS - tailS > model.burnCapS + 1e-6) warnings.push(`Burn ${(burnS - tailS).toFixed(2)} s from light to close exceeds the ${model.burnCapS} s cap.`);
  if (tailS > 0.05) warnings.push(`Tail-off: still burning ${tailS.toFixed(2)} s after the close command (downstream volume bleeding through the holes).`);
  if (neckLimitS !== null) warnings.push(`Lower neck reaches ${model.thermal.neckLimitK} K ${neckLimitS.toFixed(2)} s after light.`);
  if (steady && !steady.goxHoleChoked) warnings.push('GOx hole unchoked at steady state: GOx flow now depends on Pc.');
  if (steady && !steady.ch4HoleChoked) warnings.push('CH4 hole unchoked at steady state: CH4 flow now depends on Pc.');
  if (steady && !steady.throatChoked) warnings.push('Throat unchoked: the back pressure is setting Pc.');
  if (steady && (steady.of < model.ofMin * 1.15)) warnings.push(`Steady O/F ${steady.of.toFixed(2)} is close to the rich flammability limit.`);
  reliefsCracked.forEach((r) => warnings.push(`Relief cracks: ${r}.`));
  if (samples.some((s) => s.lit && [...s.goxVentPos, ...s.ch4VentPos].some((p) => p > 0.01))) {
    warnings.push('A vent solenoid is open while the torch is lit: it bleeds feed gas away from the injector.');
  }

  return {
    lightS, burnS, tailS, gate, steady, peakPsig, reliefsCracked,
    tcPeakC: peak('tcC'), borePeakC: peak('boreC'), neckPeakK: peak('neckK'), neckLimitS, warnings,
  };
}

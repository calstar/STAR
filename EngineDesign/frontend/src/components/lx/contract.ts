import type { BurnEvent, FlightResult, LayerXResult } from '../../api/layerx';
import { API_BASE } from '../../api/client';
import { PSI, sig } from '../layerx/format';
import { gradeLimit, marginScale, type LimitSpec, type Status } from './ui';
import type { GlossaryKey } from './glossary';
import type { CheckRow, GradedLimit, LimitKind } from './useRunData';
import type { Units } from './units';

/**
 * The result keys the physics rebuild adds (docs/layerx/DATA-CONTRACT.md), typed for the pages,
 * and a narrow accessor layer over them. Every key is optional: a run saved before a key landed
 * has none of it, and a block that failed is `{available: false, error}`. The pages ask through
 * the accessors below and show a quiet placeholder when they get null; nothing here throws.
 *
 * api/layerx.ts is another agent's: its types are extended here, not edited there.
 */

// ------------------------------------------------------------------ shared shapes

/** A column that follows a clock: null where undefined. */
export type Col = (number | null)[];

/** What a model-backed block rests on, for the run record (DATA-CONTRACT "rules"). */
export interface ModelInfo {
  name?: string;
  source?: string;
  assumptions?: string[];
  inputs?: Record<string, { value: unknown; unit?: string; provenance?: string }>;
}

/** Every block may say it failed, and may carry its model. */
export interface BlockBase {
  available?: boolean;
  error?: string;
  model?: ModelInfo;
}

// ------------------------------------------------------------------ 1. result.limits

export type Grade = 'ok' | 'warn' | 'bad' | 'info';
export type LimitGroup = 'stability' | 'injector' | 'tanks' | 'pressurant' | 'propellant' | 'flight' | 'hardware' | 'model' | string;

export interface ServerLimit {
  key: string;
  label: string;
  group?: LimitGroup;
  value: number | null;
  unit?: string;
  limit?: number | null;
  warn?: number | null;
  direction?: 'min' | 'max';
  grade: Grade;
  t_worst?: number | null;
  index_worst?: number | null;
  series_ref?: string | null;
  basis?: string;
  hint?: string;
  /** An AUDIT decision this entry waits on (D7: the chug basis). */
  decision?: string | null;
  /** From a new diagnostic: graded amber at worst until the team reviews it. */
  review_pending?: boolean | null;
  /** The grade it would have had without that cap. */
  capped_from?: Grade | null;
  frequency_hz?: number | null;
  cap_source?: string | null;
  rating_source?: string | null;
}

// ------------------------------------------------------------------ 2. result.network

export type Side3 = 'ox' | 'fuel' | 'gas';

export interface NetworkNode {
  label: string;
  kind: string;
  side?: Side3 | null;
  p_psia: Col;
  T_K?: Col;
  phase?: 'gas' | 'liquid' | string;
}

export interface NetworkBranch {
  label: string;
  kind: string;
  from: string;
  to: string;
  side?: Side3 | null;
  mdot: Col;
  dp_psi: Col;
  cv?: number | null;
  /** 0..1 open fraction, when a valve. */
  state?: Col;
}

export interface Network {
  t: number[];
  nodes: Record<string, NetworkNode>;
  branches: Record<string, NetworkBranch>;
  paths?: { ox?: string[]; fuel?: string[] };
}

// ------------------------------------------------------------------ 3. result.diagnostics

export interface LadderElement { id: string; label: string; kind: string; dp_psi: Col; share?: Col }
export interface LadderSide { elements: LadderElement[]; total_psi: Col }
export interface Ladder extends BlockBase { t: number[]; ox?: LadderSide; fuel?: LadderSide }

export interface RegulatorDiag extends BlockBase {
  t: number[];
  inlet_psia?: Col;
  outlet_psia?: Col;
  mdot?: Col;
  capacity_mdot?: Col;
  use_frac?: Col;
  droop_psi?: Col;
  spe_psi?: Col;
  choked?: (boolean | null)[];
  wide_open?: (boolean | null)[];
  cv?: number | null;
}

export interface SolenoidDiag { id: string; label?: string; side?: Side3 | null; cv?: number | null; dp_psi: Col; share_of_reg_to_tank?: Col }

export interface PressurantDiag extends BlockBase {
  species?: string;
  loaded_kg?: number | null;
  used_kg?: number | null;
  residual_kg?: number | null;
  required_kg?: number | null;
  margin_kg?: number | null;
  bottle_T_K?: Col;
  jt_dT_K?: Col;
}

export interface SaturationNode { id: string; label: string; side?: Side3 | null; margin_psi: Col; min_psi?: number | null; t_min?: number | null }
export interface SaturationDiag extends BlockBase { nodes: SaturationNode[] }

export interface CavitationSide { K: Col; K_incipient?: number | null; L_over_d?: number | null; flip_risk?: boolean; min_K?: number | null; t_min?: number | null }
export interface CavitationDiag extends BlockBase { ox?: CavitationSide; fuel?: CavitationSide }

export interface InjectorDiag extends BlockBase {
  t: number[];
  v_ox?: Col;
  v_fuel?: Col;
  momentum_ratio?: Col;
  design_momentum_ratio?: number | null;
  resultant_angle_deg?: Col;
  eta_cstar?: Col;
}

export interface StabilityDiag extends BlockBase {
  basis?: 'config' | 'drawing' | string;
  t: number[];
  margin?: Col;
  frequency_hz?: Col;
  worst?: { t: number; margin: number; frequency_hz?: number | null } | null;
  settled_min?: { t: number; margin: number } | null;
  start_window_s?: number | null;
  nyquist?: { t: number; omega: number[]; re: number[]; im: number[] } | null;
  tau_sweep?: { tau_ms: number[]; margin: Col; nominal_ms?: number | null } | null;
  acoustic?: { line: string; side?: Side3 | null; length_m: number; f_quarter_hz: number; f_half_hz: number; near_chug?: boolean }[];
  other_basis?: { basis: string; margin_min: number | null; t?: number | null } | null;
  /** The other basis's margin on the same points. */
  margin_other?: Col;
}

export interface ContourFrames { t: number[]; r_mm: number[][] }
export interface Contour { x_mm: number[]; r0_mm: number[]; frames?: ContourFrames | null; liner_r_mm?: number[] | null }

export interface HardwareDiag extends BlockBase {
  t: number[];
  throat_d_mm?: Col;
  At_ratio?: Col;
  eps?: Col;
  Lstar_m?: Col;
  contraction?: Col;
  liner_min_mm?: Col;
  insert_back_K?: Col;
  insert_back_basis?: string;
  contour?: Contour | null;
  separation?: {
    pe_pa?: Col; pe_psia?: Col; ambient_psia?: Col; summerfield?: (boolean | null)[]; schmucker_pa_crit_psia?: Col;
    /** The exit pressure below which the nozzle separates in this ambient (Schmucker): the line to plot against pe. */
    schmucker_pe_sep_psia?: Col; flag?: boolean; min_ratio?: number | null; t_min?: number | null;
  } | null;
  isp?: { ideal_s?: Col; cstar_loss_s?: Col; nozzle_loss_s?: Col; delivered_s?: Col } | null;
  soak?: { available?: boolean; peak_K?: number | null; t_peak_s?: number | null; station?: string | null; duration_s?: number | null; basis?: string } | null;
  heatmap?: string;
}

export interface ThrustShape extends BlockBase {
  mean_N?: number | null;
  dev_max_pct?: number | null;
  dev_rms_pct?: number | null;
  target_N?: number | null;
  breakdown?: { t: number[]; tank_pressure_N?: Col; erosion_N?: Col; accel_head_N?: Col } | null;
}

export interface StartDiag extends BlockBase {
  t?: number[];
  pc_psia?: Col;
  mdot_ox?: Col;
  mdot_fuel?: Col;
  mr?: Col;
  fuel_lead_s?: number | null;
  valve_travel_s?: number | null;
  prime_ox_s?: number | null;
  prime_fuel_s?: number | null;
  ignition_s?: number | null;
  impulse_deficit_Ns?: number | null;
  hard_start?: boolean;
}

export interface ShutdownDiag extends BlockBase { first_dry?: 'ox' | 'fuel' | string; mode?: string; tail_mr_max?: number | null }

export interface WaterHammerRow {
  line: string;
  side?: Side3 | null;
  closure_s?: number | null;
  joukowsky_psi?: number | null;
  slow_close_psi?: number | null;
  peak_psia?: number | null;
  rating_psia?: number | null;
  ok?: boolean | null;
  /** The surge when the main valve opens at Fire (the only case the stand sees: the mains never shut). */
  opening?: { available?: boolean; peak_psia?: number | null } | null;
}

export interface OutflowRow extends BlockBase {
  tank: string;
  side?: Side3 | null;
  ingestion_onset_s?: number | null;
  residual_kg?: number | null;
  outlet_d_mm?: number | null;
}

export interface MassCheck { loaded_kg?: number | null; burned_kg?: number | null; residual_kg?: number | null; trapped_kg?: number | null; error_pct?: number | null }
export interface VVDiag extends BlockBase {
  mass?: { ox?: MassCheck; fuel?: MassCheck };
  pressurant?: { bottle_out_kg?: number | null; ullage_in_kg?: number | null; vented_kg?: number | null; error_pct?: number | null };
  energy?: { error_pct?: number | null; basis?: string };
  convergence?: { pass: number; throat_residual?: number | null; accel_residual?: number | null }[];
  dt_check?: { dt_s?: number; half_dt_s?: number; impulse_delta_pct?: number | null; [k: string]: unknown } | null;
}

export interface LedgerEntry {
  key: string;
  label: string;
  design_value: number | null;
  unit?: string;
  delivered?: { min?: number | null; max?: number | null; mean?: number | null };
  series_ref?: string | null;
  replaced?: 'yes' | 'partly' | 'no';
  note?: string;
}

/**
 * The operating-trajectory map (GUI request; not in DATA-CONTRACT yet, shape proposed here):
 * the burn as a path over (O/F, Pc), the design point, Isp contours and the ΔP/Pc limit
 * boundaries. Absent today: the page draws the path from the series and the design point from
 * the engine reference, and adds the rest when this lands.
 */
export interface OpMap extends BlockBase {
  t?: number[];
  of?: Col;
  pc_psia?: Col;
  design?: { of: number; pc_psia: number } | null;
  isp_grid?: { of: number[]; pc_psia: number[]; isp_s: (number | null)[][] } | null;
  /** Each a curve over (O/F, Pc) where one side's ΔP/Pc reaches a band edge. */
  boundaries?: { key: string; label: string; side?: Side3 | null; edge?: 'lo' | 'hi'; of: number[]; pc_psia: number[] }[];
  chug_unstable?: { of: number[]; pc_psia: number[] } | null;
}

export interface Diagnostics {
  ladder?: Ladder;
  regulator?: RegulatorDiag;
  solenoids?: SolenoidDiag[];
  pressurant?: PressurantDiag;
  saturation?: SaturationDiag;
  cavitation?: CavitationDiag;
  injector?: InjectorDiag;
  stability?: StabilityDiag;
  hardware?: HardwareDiag;
  thrust_shape?: ThrustShape;
  start?: StartDiag;
  shutdown?: ShutdownDiag;
  water_hammer?: WaterHammerRow[];
  outflow?: OutflowRow[];
  vv?: VVDiag;
  ledger?: LedgerEntry[];
  opmap?: OpMap;
}

export type DiagKey = keyof Diagnostics;

// ------------------------------------------------------------------ 4. other additions

export interface FlightStability {
  t?: number[];
  static_margin_cal?: Col;
  cg_m?: Col;
  cp_m?: Col;
  max_q_pa?: number | null;
  max_q_t?: number | null;
  rail_exit_m_s?: number | null;
  // The scalars runs of 2026-10-02 carry (flight.py, before the series landed).
  static_margin_liftoff_cal?: number | null;
  static_margin_rail_exit_cal?: number | null;
  static_margin_burnout_cal?: number | null;
  min_stability_margin_cal?: number | null;
  min_stability_margin_time_s?: number | null;
  max_stability_margin_cal?: number | null;
  max_stability_margin_time_s?: number | null;
}

/** lib/feedtwin's trip_record (DATA-CONTRACT 4): `mawp_psia` is the absolute pressure it trips at. */
export interface Tripped { vessel: string; label?: string; kind?: string; t: number; p_psia: number; mawp_psia: number; message?: string }

export type TestMode = 'hotfire' | 'coldflow_water' | 'coldflow_ln2';

/** The axial sidecar: the wall stations' transient solution, and (`profile`) the whole contour's quasi-steady load. */
export interface AxialSidecar {
  x_mm: number[]; t: number[]; q_MW_m2: Col[]; T_wall_K: Col[];
  station?: string[]; kind?: string[]; basis?: string;
  profile?: { x_mm: number[]; r_mm?: number[]; q_MW_m2: Col[]; wall_K?: Col[]; basis?: string } | null;
}

export type ContractEvent = BurnEvent & { key?: string };

export type ContractFlight = FlightResult & { stability?: FlightStability | null; truncation?: { truncated?: boolean; cutoff_time?: number; reason?: string; message?: string } | null };

/** A LayerXResult with every DATA-CONTRACT key, all optional. */
export type ContractResult = Omit<LayerXResult, 'events' | 'flight'> & {
  events: ContractEvent[];
  flight?: ContractFlight;
  limits?: ServerLimit[] | BlockBase | null;
  network?: (Network & BlockBase) | BlockBase | null;
  diagnostics?: (Diagnostics & BlockBase) | null;
  tripped?: Tripped | null;
  test_mode?: TestMode | null;
};

export const contractOf = (r: LayerXResult): ContractResult => r as unknown as ContractResult;

// ------------------------------------------------------------------ the accessors

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A block the page can draw: present and not marked failed. */
export function usable<T>(x: T | null | undefined): T | null {
  if (x === null || x === undefined) return null;
  if (isObj(x) && x.available === false) return null;
  return x;
}

/** Why a block is missing, in the placeholder's words. */
export function missingText(x: unknown, absent = 'Not computed for this run'): string {
  if (isObj(x) && x.available === false) return typeof x.error === 'string' && x.error ? `Not computed: ${x.error.split('\n')[0]}` : absent;
  return absent;
}

/** A column as long as its clock, or null when it is missing or the wrong length. */
export function colOf(c: unknown, n?: number): Col | null {
  if (!Array.isArray(c) || !c.length) return null;
  if (n !== undefined && c.length !== n) return null;
  return c.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
}

/** The value of a column at an index, or null. */
export function colAt(c: readonly (number | null | undefined)[] | null | undefined, i: number): number | null {
  if (!c || i < 0 || i >= c.length) return null;
  const v = c[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * result.diagnostics with every failed block dropped, so `diag(r).ladder` is drawable or
 * undefined. The raw block (for its error) is `rawDiag(r).ladder`.
 */
export function diag(r: LayerXResult | null | undefined): Diagnostics {
  const d = r ? contractOf(r).diagnostics : null;
  if (!isObj(d) || d.available === false) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'available' || k === 'error' || k === 'model') continue;
    if (Array.isArray(v)) out[k] = v.length ? v : undefined;
    else if (usable(v)) out[k] = v;
  }
  return out as Diagnostics;
}

export function rawDiag(r: LayerXResult | null | undefined): Partial<Record<DiagKey, unknown>> {
  const d = r ? contractOf(r).diagnostics : null;
  return isObj(d) ? (d as Partial<Record<DiagKey, unknown>>) : {};
}

/** The placeholder words for one diagnostics block. */
export function diagMissing(r: LayerXResult | null | undefined, key: DiagKey): string {
  const d = r ? contractOf(r).diagnostics : null;
  if (isObj(d) && d.available === false) return missingText(d);
  return missingText(rawDiag(r)[key]);
}

/** True when a diagnostics block is there but failed: it keeps its panel, with the reason. */
export function diagFailed(r: LayerXResult | null | undefined, key: DiagKey): boolean {
  const d = r ? contractOf(r).diagnostics : null;
  if (isObj(d) && d.available === false) return true;
  const b = rawDiag(r)[key];
  return isObj(b) && b.available === false;
}

/** result.network when it is there and its columns follow its clock. */
export function networkOf(r: LayerXResult | null | undefined): Network | null {
  const n = r ? usable(contractOf(r).network) : null;
  if (!isObj(n) || !Array.isArray(n.t) || !isObj(n.nodes) || !isObj(n.branches)) return null;
  return n as unknown as Network;
}

/** The ledger rows when the backend writes them, else null (the page derives its own). */
export function ledgerOf(r: LayerXResult | null | undefined): LedgerEntry[] | null {
  const l = diag(r).ledger;
  return l && l.length ? l : null;
}

export function trippedOf(r: LayerXResult | null | undefined): Tripped | null {
  const t = r ? contractOf(r).tripped : null;
  return isObj(t) && typeof t.t === 'number' ? (t as Tripped) : null;
}

export function testModeOf(r: LayerXResult | null | undefined): TestMode | null {
  const m = r ? contractOf(r).test_mode : null;
  return m === 'hotfire' || m === 'coldflow_water' || m === 'coldflow_ln2' ? m : null;
}

/** result.flight.stability in either shape: the contract's series, or the scalars of older runs. */
export function flightStabilityOf(f: FlightResult | null | undefined): FlightStability | null {
  const s = (f as ContractFlight | null | undefined)?.stability;
  return isObj(s) ? (s as FlightStability) : null;
}

/** An event's stable id: the backend's `key` when it writes one. */
export function eventKeyOf(e: BurnEvent): string | null {
  const k = (e as ContractEvent).key;
  return typeof k === 'string' && k ? k : null;
}

/**
 * A dotted reference into the result ("diagnostics.stability.margin") as a column, with the clock
 * it follows: the block's own `t` when it has one, else the series'. Null when it does not
 * resolve to a numeric column.
 */
export function resolveRef(r: LayerXResult | null | undefined, ref: string | null | undefined): { t: number[]; values: Col } | null {
  if (!r || !ref) return null;
  const parts = ref.split('.');
  let node: unknown = r;
  let clock: number[] | null = null;
  for (const p of parts) {
    if (!isObj(node)) return null;
    if (Array.isArray(node.t) && node.t.length && typeof node.t[0] === 'number') clock = node.t as number[];
    node = node[p];
  }
  const values = colOf(node);
  if (!values) return null;
  const t = clock && clock.length === values.length ? clock : r.series.t.length === values.length ? r.series.t : null;
  return t ? { t, values } : null;
}

// ------------------------------------------------------------------ result.limits as the pages' limits

/** The chart series a limit's worst point lies on, by its key, so a margin bar's jump rings it. */
const FOCUS_OF: Record<string, string> = {
  chug_margin: 'chug', chug: 'chug', chug_margin_settled: 'chug', chug_margin_other_basis: 'chug', chug_margin_start: 'chug',
  stiffness_ox: 'stiff_lox', stiffness_lox: 'stiff_lox', stiff_lox: 'stiff_lox', dp_pc_ox: 'stiff_lox', stiffness_ox_ignition: 'stiff_lox',
  stiffness_fuel: 'stiff_fuel', stiff_fuel: 'stiff_fuel', dp_pc_fuel: 'stiff_fuel', stiffness_fuel_ignition: 'stiff_fuel',
  bottle_over_lockup: 'bottle', bottle: 'bottle', bottle_margin: 'bottle',
  tank_mawp_ox: 'lox_tank', tank_meop_ox: 'lox_tank', tank_cap_ox: 'lox_tank',
  tank_mawp_fuel: 'fuel_tank', tank_meop_fuel: 'fuel_tank', tank_cap_fuel: 'fuel_tank',
  cavitation_ox: 'pc', cavitation_fuel: 'pc', separation: 'pc', engine_fit: 'pc',
};

/** A limit's focus key: the table above, a saturation node's own, or the tank its series names. */
export function focusOf(l: Pick<ServerLimit, 'key' | 'series_ref'>): string {
  if (FOCUS_OF[l.key]) return FOCUS_OF[l.key];
  if (l.key.startsWith('saturation_')) return `sat-${l.key.slice('saturation_'.length)}`;
  if (l.key === 'tank_sag') return /\bfuel\b/.test(l.series_ref ?? '') ? 'fuel_tank' : 'lox_tank';
  return l.key;
}

/** The glossary entry a limit's label underlines, by its key. */
const TERM_OF: [RegExp, GlossaryKey][] = [
  [/chug/, 'chugMargin'], [/stiff|dp_?pc/, 'stiffness'], [/mawp/, 'mawp'], [/meop/, 'meop'], [/bottle|lockup/, 'lockup'],
  [/sag/, 'tankPressure'], [/dry|residual|leftover/, 'residual'], [/saturation/, 'saturationMargin'], [/cavitation/, 'cavitationNumber'],
  [/hammer/, 'waterHammer'], [/separation/, 'separation'], [/static_margin|stability_margin/, 'staticMargin'], [/max_?q/, 'maxQ'],
  [/peak/, 'mawp'],
];

/** Keys whose unit-free value is a fraction shown as a percent. */
const FRACTION_KEY = /stiff|dp_?pc|frac|share|use|percent|pct|error|conservation|wide_open|engine_fit/i;
/** psi keys that are a drop (one decimal) rather than a gap to a line (whole psi). */
const DROP_KEY = /sag|drop|loss|droop|dip|dp/i;

/** The display quantity a server limit is in, and how its model value converts into it. */
export function limitKindOf(l: Pick<ServerLimit, 'key' | 'unit'>): { kind: LimitKind; toModel: (x: number) => number; suffix: string } {
  const unit = (l.unit ?? '').trim();
  const id = { toModel: (x: number) => x, suffix: '' };
  switch (unit) {
    case '%': return { kind: 'percent', toModel: (x) => x / 100, suffix: '' };
    case 'frac': case 'fraction': return { kind: 'percent', ...id };
    case 'psi': return { kind: DROP_KEY.test(l.key) ? 'dp' : 'pgap', ...id };
    case 'psia': return { kind: 'pressure', ...id };
    // A dynamic pressure (max-Q) is a difference, not an absolute reading.
    case 'Pa': return { kind: 'pgap', toModel: (x) => x / PSI, suffix: '' };
    case 'kg': return { kind: 'mass', ...id };
    case 'kg/s': return { kind: 'mdot', ...id };
    case 's': return { kind: 'time', ...id };
    case 'm': return { kind: 'length', ...id };
    case 'mm': return { kind: 'length', toModel: (x) => x / 1000, suffix: '' };
    case 'N': return { kind: 'force', ...id };
    case 'K': return { kind: 'temp', ...id };
    case 'Hz': return { kind: 'frequency', ...id };
    case 'm/s': return { kind: 'velocity', ...id };
    case '': case '-': return FRACTION_KEY.test(l.key) ? { kind: 'percent', ...id } : { kind: 'ratio', ...id };
    // Calibers, g, and anything else: a plain number with its unit written after it.
    default: return { kind: 'ratio', toModel: (x) => x, suffix: unit };
  }
}

const GRADE_STATUS: Record<Grade, Status> = { ok: 'ok', warn: 'warn', bad: 'bad', info: 'ok' };

/** The words a server limit's flags add to its hover card. */
function flagWords(l: ServerLimit): string {
  const out: string[] = [];
  if (l.review_pending) {
    out.push(`A new check: graded amber at most until the team reviews its ratings${l.capped_from === 'bad' ? ' (it would be red)' : ''}.`);
  }
  if (l.decision) out.push(`Waits on decision ${l.decision}.`);
  return out.join(' ');
}

/**
 * Checks the team made information on 2026-10-03, which runs graded before then still carry as
 * amber: which tank runs dry first, the tank limits ("don't worry about tank limits for now") and
 * water hammer (the mains open for Fire and never close).
 */
const INFO_SINCE_2026_10_03 = /^(depletion_tie|tank_(mawp|meop|cap)_|water_hammer_)/;

/** One server limit as the pages' GradedLimit. The server's grade is the grade. */
export function fromServerLimit(l: ServerLimit): GradedLimit {
  const { kind, toModel, suffix } = limitKindOf(l);
  const conv = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : toModel(x));
  const value = conv(l.value);
  const lim = conv(l.limit);
  const warn = conv(l.warn);
  const direction = l.direction === 'max' ? 'lower-is-safer' : 'higher-is-safer';
  // "info" is the server's word only: a graded limit with no red line is still counted. Runs graded
  // before 2026-10-03 called "runs dry first" amber; it is information (the team's call).
  const info = l.grade === 'info' || INFO_SINCE_2026_10_03.test(l.key);
  const edge = lim ?? warn;
  const spec: LimitSpec = { limit: edge ?? (value ?? 0), warn: lim === null ? undefined : warn ?? undefined, direction };
  const status = INFO_SINCE_2026_10_03.test(l.key) ? 'ok' : GRADE_STATUS[l.grade] ?? (value === null || info ? 'ok' : gradeLimit(spec, value));
  const worstT = typeof l.t_worst === 'number' && Number.isFinite(l.t_worst) ? l.t_worst : null;
  const worstWord = worstT === null ? 'at' : l.index_worst === null || l.index_worst === undefined ? 'at' : l.direction === 'max' ? 'max' : 'min';
  return {
    key: l.key,
    // Runs graded before 2026-10-03 called the bottle's margin "Bottle at burnout", the same words as
    // the bottle's pressure on the verdict strip: two numbers under one name.
    label: l.key === 'bottle_margin' && l.label === 'Bottle at burnout' ? 'Bottle over lockup at burnout' : l.label,
    kind,
    value,
    spec,
    status,
    margin: info || edge === null ? Infinity : marginScale(spec, value).margin,
    worstT,
    worstWord,
    focusKey: focusOf(l),
    termKey: TERM_OF.find(([re]) => re.test(l.key))?.[1],
    // Those runs also quoted the bottle in psia here while the page reads it in psig: drop the figure.
    hint: [l.key === 'bottle_margin' ? l.hint?.replace(/ \(\d[\d,.]* psia\)/, '') : l.hint, flagWords(l), l.basis].filter(Boolean).join(' '),
    info,
    noLine: lim === null,
    group: l.group,
    reviewPending: !!l.review_pending,
    decision: l.decision ?? undefined,
    text: (u: Units) => {
      const s = u.scale(kind);
      const f = (x: number | null) => (x === null ? '—' : suffix ? `${sig(s.to(x))}\u00a0${suffix}` : u.fmt({ value: s.to(x), unit: s.unit, digits: s.digits }));
      const word = direction === 'higher-is-safer' ? '≥' : '≤';
      return { value: f(value), limit: edge === null ? '' : `${word} ${f(edge)}` };
    },
  };
}

/** result.limits when the backend grades the run, as GradedLimits (unsorted); else null. */
export function serverLimits(r: LayerXResult | null | undefined): GradedLimit[] | null {
  const l = r ? contractOf(r).limits : null;
  if (!Array.isArray(l) || !l.length) return null;
  const ok = l.filter((x): x is ServerLimit => isObj(x) && typeof x.key === 'string' && typeof x.label === 'string' && typeof x.grade === 'string');
  return ok.length ? ok.map(fromServerLimit) : null;
}

/**
 * A water-hammer limit's moment, which the server grades without one (the surge is not a point on
 * the series): the row's own clock -- the mains' closure (`at_s`) when the peak is the closing surge,
 * the side's priming (diagnostics.start `prime_*_s`) when it is the opening one. So its bar can jump.
 */
function withHammerTime(r: LayerXResult | null | undefined, l: GradedLimit): GradedLimit {
  if (!l.key.startsWith('water_hammer_') || l.worstT !== null || !r) return l;
  const line = l.key.slice('water_hammer_'.length);
  const rows = rawDiag(r).water_hammer;
  const row = Array.isArray(rows) ? (rows as (WaterHammerRow & { peak_source?: string; at_s?: number | null; valve?: string })[]).find((w) => w?.line === line) : undefined;
  if (!row) return l;
  const start = diag(r).start;
  const opening = /^opening/.test(row.peak_source ?? '');
  const t = opening ? (row.side === 'fuel' ? start?.prime_fuel_s : start?.prime_ox_s) : row.at_s;
  if (typeof t !== 'number' || !Number.isFinite(t)) return l;
  const when = opening ? 'when the column reaches the injector at the start' : 'when the main valve shuts';
  return { ...l, worstT: t, worstWord: 'at', focusKey: row.valve ? `node:${row.valve}` : 'pc', hint: `${l.hint} The peak is ${when}.` };
}

/**
 * The server's graded entries split for the page: those with a red line are margin bars; those
 * with none (the propellant left over, the engine table, the solver: a count or an amber edge only)
 * are status rows, still counted in the verdict unless the server calls them info.
 */
export function serverGrading(r: LayerXResult | null | undefined, u?: Units): { limits: GradedLimit[]; checks: CheckRow[] } | null {
  const all = serverLimits(r)?.map((l) => withHammerTime(r, l));
  if (!all) return null;
  const limits = all.filter((l) => l.info || !l.noLine);
  const checks: CheckRow[] = all.filter((l) => !l.info && l.noLine).map((l) => {
    const t = u ? l.text(u) : { value: l.value === null ? '—' : sig(l.value), limit: '' };
    return { key: l.key, label: l.label, status: l.status, value: t.value, limit: t.limit, hint: l.hint, text: l.text, worstT: l.worstT };
  });
  return { limits, checks };
}

/** The limits the pages draw: the backend's when it grades the run, else the ported ones. */
export function limitsOf(r: LayerXResult | null | undefined, fallback: GradedLimit[]): GradedLimit[] {
  return serverGrading(r)?.limits ?? fallback;
}

// ------------------------------------------------------------------ endpoints the contract adds

export const sidecarUrl = (runId: string, name: 'axial') => `${API_BASE}/layerx/runs/${encodeURIComponent(runId)}/sidecar/${name}`;
export const exportUrl = (runId: string, fmt: 'csv' | 'parquet' | 'fea') => `${API_BASE}/layerx/runs/${encodeURIComponent(runId)}/export/${fmt}`;

/** The axial sidecar, or why not ("not computed" on a 404: the run, or the server, predates it). */
export async function fetchAxial(runId: string, signal?: AbortSignal): Promise<{ data?: AxialSidecar; missing?: string }> {
  try {
    const res = await fetch(sidecarUrl(runId, 'axial'), { signal });
    if (res.status === 404) return { missing: 'Not computed for this run' };
    if (!res.ok) return { missing: `Not available (HTTP ${res.status})` };
    const body = (await res.json()) as unknown;
    if (!isObj(body) || !Array.isArray(body.x_mm) || !Array.isArray(body.t) || !Array.isArray(body.q_MW_m2)) return { missing: 'Not computed for this run' };
    return { data: body as unknown as AxialSidecar };
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return {};
    return { missing: 'Not available: the server did not answer' };
  }
}

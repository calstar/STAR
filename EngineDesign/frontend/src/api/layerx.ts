/**
 * Layer X: the feed system and the engine, burned together (backend/routers/layerx.py).
 *
 * Every pressure here is absolute (psia). The feed twin's gauge zero is the standard
 * atmosphere and the launch site is not, so nothing crosses this boundary as psig except
 * the COPV dial setting, which is what a person reads off the bottle's gauge.
 */

import { API_BASE } from './client';
import type { TimeSeriesData, TimeSeriesSummary } from './client';

export type EngineModel = 'card' | 'calibrated' | 'native';

export interface LayerXSettings {
  drawing_id: string;
  tank_pressure_psia?: number | null;
  copv_pressure_psig?: number | null;
  load: 'config' | 'fill';
  fill_fraction: number;
  /** Liquid left in a tank when the burn is over [kg]; 0.001 burns the tanks dry. */
  dry_kg: number;
  engine_model: EngineModel;
  /** The feed twin's thermal models: null runs the twin's own Setup; a value overrides it. */
  ullage_collapse: boolean | null;
  ullage_vapour: boolean | null;
  chilldown: number | null;
  line_walls: boolean | null;
  hold_s: number;
  dt: number;
  horizon_s: number;
  settle: boolean;
  replay: boolean;
  flight: boolean;
  /** The vehicle as weighed on the rail, loaded and pressed [kg]; null: the design's vehicle. */
  liftoff_mass_kg?: number | null;
  /** Swap the drawing's pressurant for this burn; null: as drawn. */
  pressurant?: 'nitrogen' | 'helium' | null;
  /** An injector what-if on this run's copy of the design (holes, angles, passage L/d). */
  design_patch?: DesignPatch | null;
  // Opt-in choices (docs/layerx/DATA-CONTRACT.md 7). Unset or null is today's behaviour, exactly.
  /** The feed basis the graded chug margin uses; null: 'config', graded on the whole burn (AUDIT D7). */
  chug_basis?: ChugBasis | null;
  /** Chug model on each point's eroded geometry; null: the design point's. Reported margins only. */
  chug_eroded?: boolean | null;
  /** Engine card's nozzle follows the eroding throat (AUDIT D4-B); null: as built. */
  card_eroded_nozzle?: boolean | null;
  /** With flight: 'outer' (fly, burn again) or 'inline' (a 1-DOF ascent inside each pass); null: 'outer'. */
  flight_coupling?: FlightCoupling | null;
  /** Start diagnostic only: fuel main this long before the LOX main [s]; null: 0, the DAQ table's. */
  fuel_lead_s?: number | null;
  /** Start diagnostic only: main-valve opening travel [s]; null: the drawing's travel_time. */
  valve_travel_s?: number | null;
  /** Gas-ingestion diagnostic only: tank outlet bore [mm], one for both or [LOX, fuel]; null: the first line's. */
  outlet_d_mm?: number | [number | null, number | null] | null;
  /** Run a nitrogen-over-LOX hot fire anyway (condensation unmodelled); null: preflight refuses it. */
  ack_gn2_condensation?: boolean | null;
  /** Reserved: only 'hotfire' is modelled. */
  test_mode?: 'hotfire' | null;
}

export type ChugBasis = 'config' | 'drawing';
export type FlightCoupling = 'outer' | 'inline';

export interface MassBudget {
  airframe_kg: number;
  /** 'config': the design's airframe_mass. 'liftoff mass': what is left of the weighed vehicle. */
  airframe_source: 'config' | 'liftoff mass';
  motor_dry_kg: number;
  oxidizer_kg: number;
  fuel_kg: number;
  pressurant_kg: number;
  ullage_gas_kg: number;
  liftoff_kg: number;
}

export type DesignPatch = Partial<Record<'oxidizer' | 'fuel', { d_jet?: number; impingement_angle?: number; orifice_l_over_d?: number }>>;

export const DEFAULT_SETTINGS: Omit<LayerXSettings, 'drawing_id'> = {
  tank_pressure_psia: null,
  copv_pressure_psig: null,
  load: 'config',
  fill_fraction: 0.95,
  dry_kg: 0.001,
  engine_model: 'card',
  ullage_collapse: null,
  ullage_vapour: null,
  chilldown: null,
  line_walls: null,
  hold_s: 300,
  dt: 0.05,
  horizon_s: 14,
  settle: true,
  replay: true,
  flight: true,
  liftoff_mass_kg: null,
  pressurant: null,
  design_patch: null,
};

export interface DrawingSummary {
  readable: boolean;
  error?: string;
  symbols?: number;
  lines?: number;
  tanks?: { id: string; label: string; fluid: string; volume_L: number | null; mawp_psi: number | null }[];
  bottles?: { id: string; label: string; fluid: string; volume_L: number | null; pressure_psi: number | null; mawp_psi: number | null }[];
  regulators?: { id: string; label: string; dome_loaded: boolean; setpoint_psi: number | null; dome_bias_psi: number | null; supply_coefficient: number | null; flow_droop_psi: number | null }[];
  engines?: { id: string; label: string }[];
  valves?: number;
}

export interface Drawing {
  id: string;
  name: string;
  source: string;
  sha256: string;
  added: number;
  summary: DrawingSummary;
}

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CardFit {
  envelope_chamber_pc: number;
  envelope_chamber_thrust: number;
  envelope_dp_O: number;
  envelope_dp_F: number;
  envelope_closed_pc: number;
  envelope_closed_thrust: number;
  envelope_closed_mdot: number;
  envelope_points: number;
  box_closed_pc: number;
  box_closed_thrust: number;
  box_closed_mdot: number;
  box_points: number;
  envelope_worst: number;
  tolerance: number;
}

export interface CardProvenance {
  tool: string;
  config_sha256: string;
  boundary: string;
  sampler: string;
  samples: number;
  solves: number;
  center_psia: number;
  scan_levels: number[];
  scan_ratios: number[];
  envelope_levels: number[];
  envelope_ratios: number[];
  built_s: number;
  within_tolerance: boolean;
}

export interface Calibration {
  mode: EngineModel;
  fit?: CardFit;
  card?: CardProvenance;
  chamber_grid?: number[];
  injector_grid?: number[];
  of_range?: number[];
  mdot_range?: number[];
  cd_O?: number;
  cd_F?: number;
  native_cd_O?: number;
  native_cd_F?: number;
  eta_cstar?: number;
  eta_n?: number;
  ed_cd_O?: number;
  ed_cd_F?: number;
  ed_eta_cstar?: number;
  residual_pc?: number;
  residual_thrust?: number;
  tank_psia_O?: number;
  tank_psia_F?: number;
}

export interface Preflight {
  ok: boolean;
  checks: Check[];
  derived: Record<string, unknown> & {
    target_lockup_psia?: number;
    dome_psig?: number;
    copv_psig?: number;
    loads_kg?: Record<string, number> | null;
    roles?: { oxidiser: string; fuel: string };
    ambient_pa?: number;
    tank_volumes_L?: Record<string, number | null>;
  };
  calibration: Calibration | null;
  reference: Record<string, number> | null;
}

export interface SideSeries {
  tank_psia: number[];
  outlet_psia: number[];
  inlet_psia: number[];
  dump_psi: number[];
  manifold_psia: number[];
  dp_injector_psi: number[];
  stiffness: number[];
  mdot: number[];
  liquid_kg: number[];
  ullage_K: number[];
  liquid_K: number[];
  fill_fraction: number[];
}

export interface Series {
  t: number[];
  firing: boolean[];
  converged: boolean[];
  copv_psia: number[];
  copv_mass_kg: number[];
  copv_wall_K: number[];
  regulators: Record<string, { label: string; outlet_psia: number[] }>;
  ox: SideSeries;
  fuel: SideSeries;
  chamber: { pc_psia: number[]; mr: number[]; thrust_N: number[]; isp_s: number[]; cstar: number[]; extrapolated: number[] };
  /** What each instrument on the drawing reads (runs before 2026-10-02 lack it). */
  instruments?: Record<string, { tag: string; type: string; unit: 'psia' | 'K'; values: number[] }>;
}

export interface DaqChannel { name: string; kind: string; group: string; purpose: string; max_psi?: number | null }

export interface SideSummary {
  t0_psia: number;
  min_psia: number | null;
  end_psia: number;
  ignition_dip_psi: number;
  inlet_mean_psia: number | null;
  dp_injector_min_psi: number | null;
  stiffness_min: number | null;
  /** The first 0.2 s, ignition, which stiffness_min leaves out (runs before 2026-10-02 lack it). */
  stiffness_min_ignition?: number | null;
  stiffness_mean: number | null;
  /** Highest tank pressure over hold and burn [psia]. */
  peak_psia?: number | null;
  loaded_kg: number;
  residual_kg: number;
}

export interface Summary {
  burn_time_s: number;
  /** In the Recent listing only, for a flown burn. */
  apogee_agl_m?: number | null;
  /** In the Recent listing only, for a burn a vessel trip stopped (result.tripped). */
  tripped?: Pick<TrippedRecord, 'vessel' | 'label' | 't' | 'p_psia' | 'mawp_psia'> | null;
  depleted_tank: string;
  depleted_side: '' | 'oxidiser' | 'fuel';
  total_impulse_Ns: number;
  mean_thrust_N: number | null;
  peak_thrust_N: number | null;
  min_thrust_N: number | null;
  thrust_t0_N: number | null;
  pc_mean_psia: number | null;
  pc_min_psia: number | null;
  pc_max_psia: number | null;
  of_mean: number | null;
  of_min: number | null;
  of_max: number | null;
  isp_mean_s: number | null;
  propellant_used_kg: number;
  ox: SideSummary;
  fuel: SideSummary;
  copv_t0_psia: number | null;
  copv_end_psia: number | null;
  copv_used_kg: number | null;
  regulators: Record<string, { label: string; t0_psia: number; min_psia: number | null }>;
  steps: number;
  failed_steps: number;
  extrapolated_steps: number;
  engine_model?: EngineModel;
  card_outside_steps?: number | null;
  t0_settled: boolean;
  dt: number;
}

export interface BurnEvent {
  t: number;
  /** 'fail': the burn stopped here (a vessel trip, key 'trip'). */
  kind: 't0' | 'fire' | 'min' | 'end' | 'warn' | 'fail';
  label: string;
  detail: string;
  /** Stable id (DATA-CONTRACT 4): t0, fuel_lead, fire, ignition, min_tank_ox, min_tank_fuel, min_chug,
   *  dry_ox, dry_fuel, burnout, trip, warn:<n>. Absent on runs saved before 2026-10-03. */
  key?: string;
}

export interface CrossCheckRow {
  key: string;
  label: string;
  unit: string;
  layerx: number | null;
  enginedesign: number | null;
  rel: number | null;
}

export interface CrossCheck {
  available: boolean;
  error?: string;
  t?: number;
  tank_psia_O?: number;
  tank_psia_F?: number;
  rows?: CrossCheckRow[];
  basis?: string;
}

export interface Assumption {
  component: string;
  parameter: string;
  value: number;
  unit: string;
  source: string;
  reference: string;
}

export interface Provenance {
  drawing: { id: string; name: string; source: string; sha256: string };
  config_sha256: string;
  settings: LayerXSettings;
  derived: Preflight['derived'];
  setup: Record<string, unknown>;
  plan: Record<string, unknown>;
  calibration: Calibration | null;
  engine_reference: Record<string, number> | null;
  assembly: { symbols: number; lines: number; nodes: number; branches: number; unstated: number; assumptions: Assumption[]; warnings: string[] };
  notes: string[];
  probes: Record<string, unknown>;
  created: number;
  phase: number;
  wall_s?: number;
  feedtwin_version?: string;
}

export interface EngineCheckRow {
  t: number;
  available: boolean;
  inlet_O_psia?: number;
  inlet_F_psia?: number;
  layerx?: { pc: number; thrust: number; mdot_O: number; mdot_F: number };
  enginedesign?: { pc: number; thrust: number; mdot_O: number; mdot_F: number };
  rel?: { pc: number | null; thrust: number | null; mdot_O: number | null; mdot_F: number | null };
}

export interface EngineCheck {
  available: boolean;
  mode?: EngineModel;
  against?: 'replay' | 'card-geometry';
  rows?: EngineCheckRow[];
  worst?: { pc: number; thrust: number; mdot_O: number; mdot_F: number };
  basis?: string;
}

export interface Replay {
  available: boolean;
  error?: string;
  t: number[];
  index: number[];
  inlet_O_psia: number[];
  inlet_F_psia: number[];
  pc_psia: (number | null)[];
  thrust_N: (number | null)[];
  mdot_O: (number | null)[];
  mdot_F: (number | null)[];
  isp_s: (number | null)[];
  A_throat_m2: number[];
  throat_area_ratio: (number | null)[];
  recession_throat_mm: (number | null)[] | null;
  recession_chamber_mm: (number | null)[] | null;
  heat_flux_throat_MW_m2: (number | null)[] | null;
  T_graphite_surface_K: (number | null)[] | null;
  char_depth_peak_mm: (number | null)[] | null;
  chug_margin: (number | null)[] | null;
  throat_ablation: boolean;
  liner_ablation: boolean;
}

export interface PassFigures {
  total_impulse_Ns: number | null;
  mean_thrust_N: number | null;
  pc_mean_psia: number | null;
  isp_mean_s: number | null;
  burn_time_s: number | null;
  of_mean: number | null;
  ox_dp_injector_min_psi: number | null;
  fuel_dp_injector_min_psi: number | null;
  ox_manifold_mean_psia: number | null;
  fuel_manifold_mean_psia: number | null;
}

/** The drawing's path from a tank to its injector (engine/layerx/flight.py line_paths). */
export interface VehicleLine {
  side: 'oxidiser' | 'fuel';
  lines: string[];
  length_m: number;
  drop_m: number;
  used: 'drawing' | 'restated' | 'none';
  too_steep: string[];
}

/** Phase 6 (engine/layerx/flight.py): the delivered burn flown, its acceleration fed back. */
export interface FlightResult {
  ok: boolean;
  error?: string;
  apogee_agl_m: number;
  apogee_msl_m: number;
  apogee_time_s: number;
  max_velocity_m_s: number;
  max_mach: number;
  rail_exit_velocity_m_s: number;
  rail_exit_time_s: number;
  liftoff_accel_g: number;
  max_accel_g: number;
  max_accel_time_s: number;
  liftoff_mass_kg: number;
  burnout_mass_kg: number;
  /** What the vehicle lifted off at, part by part (runs before 2026-10-02 lack it). */
  mass_budget?: MassBudget | null;
  ceiling: { limit_m: number; datum: string; limit_agl_m: number; margin_m: number; passed: boolean } | null;
  checks: { name: string; value: number; limit: number; kind: string; passed: boolean; note?: string | null }[];
  notes: string[];
  trajectory: { t: number[]; altitude_m: number[]; velocity_m_s: number[]; mach: number[]; accel_axial_g: number[] };
  schedule: { t: number[]; accel_m_s2: number[] };
  pad: PassFigures | null;
  in_flight: PassFigures | null;
  vehicle_lines: VehicleLine[];
}

export interface ReplayPass {
  pass: number;
  throat_applied: boolean;
  accel_applied?: boolean;
  accel_change?: number | null;
  apogee_agl_m?: number;
  throat_growth: number | null;
  schedule_change: number;
  burn_time_s: number;
  agreement: { available: boolean; worst?: { mdot_O: number; mdot_F: number; pc: number } };
}

export interface Delivered {
  t: number[];
  /** The nozzle's state over the burn (replay), and the air it exhausts into. */
  p_exit_psia?: number[];
  t_exit_K?: number[];
  gamma_exit?: number[];
  tc_K?: number[];
  eps?: number[];
  ambient_psia?: number[];
  /** EngineDesign's chug gain margin on each firing step (runs before 2026-10-02 lack it). */
  chug_margin?: (number | null)[];
  thrust_N: number[];
  pc_psia: number[];
  mdot_O: number[];
  mdot_F: number[];
  isp_s: number[];
  mr: number[];
  throat_area_ratio: number[];
  recession_throat_mm: number[];
  summary: {
    total_impulse_Ns: number;
    mean_thrust_N: number | null;
    peak_thrust_N: number | null;
    min_thrust_N: number | null;
    pc_mean_psia: number | null;
    pc_min_psia: number | null;
    pc_max_psia: number | null;
    isp_mean_s: number | null;
    propellant_burned_kg: number;
    throat_area_growth: number | null;
    throat_recession_mm: number | null;
    /** EngineDesign's chug gain margin, lowest over the burn (ignition included), and when. */
    chug_margin_min?: number | null;
    chug_margin_min_t?: number | null;
  };
}

export interface FeedFitSide {
  label: string;
  mdot_kg_s: number;
  velocity_head_psi: number;
  lockup_psia: number;
  tank_firing_psia: number;
  supply_deficit_psi: number;
  supply_deficit_worst_psi: number;
  line_loss_psi: number;
  line_loss_design_psi: number;
  manifold_psia: number;
  manifold_design_psia: number;
  manifold_gap_psi: number;
  manifold_fitted_psia: number;
  fitted_rms_psi: number;
  K_line: number;
  K_supply: number;
  K0: number;
  K0_design: number;
  design_path: string;
}

/** engine/layerx/feedfit.py: the drawing's feed in the form the injector is designed with. */
export interface FeedFit {
  available: boolean;
  error?: string;
  flown?: boolean;
  basis?: string;
  sides?: Record<'oxidizer' | 'fuel', FeedFitSide>;
  drawing?: { id: string; name: string; sha256: string };
  design_update?: { feed_system: Record<string, Record<string, unknown> & { derived_from: Record<string, unknown> }> };
}

export interface LayerXResult {
  series: Series;
  summary: Summary;
  events: BurnEvent[];
  provenance: Provenance;
  checks: Check[];
  cross_check?: CrossCheck;
  engine_check?: EngineCheck;
  replay?: Replay;
  passes?: ReplayPass[];
  converged?: boolean;
  delivered?: Delivered | null;
  timeseries?: { data: TimeSeriesData; summary: TimeSeriesSummary; source: string };
  flight?: FlightResult;
  feed_fit?: FeedFit;
  /** Names of this run's sidecars (GET /runs/{id}/sidecar/{name}); absent: none. */
  sidecars?: string[];
  /** DATA-CONTRACT 2: every node and branch of the feed, every twin step (runs from 2026-10-03). */
  network?: FeedNetwork | { available?: boolean; error?: string } | null;
  /** DATA-CONTRACT 4: the vessel trip that stopped the burn; absent when nothing tripped. When
   *  present the burn's totals end at ``t`` and ``converged`` is false. */
  tripped?: TrippedRecord | null;
}

/** result.tripped (lib/feedtwin trip_record). Pressures absolute; ``mawp_psia`` is what the stand trips at.
 *  The server always sends every field; the optional ones are optional so components/lx/contract.ts's
 *  narrower view of the same block (and its fixtures) intersects with this one. */
export interface TrippedRecord {
  vessel: string;
  label?: string;
  kind?: 'tank' | 'bottle' | string;
  /** Seconds from Fire (negative in the lead-in). */
  t: number;
  p_psia: number;
  mawp_psia: number;
  message?: string;
}

/** result.network (DATA-CONTRACT 2). Node values are each step's last network solve, not vessel states.
 *  The server sends every field; optional ones are optional for components/lx/contract.ts, as above. */
export interface FeedNetwork {
  t: number[];
  nodes: Record<string, {
    label?: string; kind: string; side?: 'ox' | 'fuel' | 'gas' | null; phase?: 'gas' | 'liquid' | string;
    /** Columns on ``t``; null where a value was not finite. */
    p_psia: (number | null)[]; T_K?: (number | null)[];
  }>;
  branches: Record<string, {
    label?: string; kind: string; from: string; to: string; side?: 'ox' | 'fuel' | 'gas' | null;
    mdot: (number | null)[]; dp_psi?: (number | null)[]; cv?: number | null;
    /** 0..1 open fraction, valves only. */
    state?: (number | null)[];
    /** Reported against its drawn direction, because a path runs it that way. */
    reversed?: boolean;
  }>;
  paths?: { ox?: string[]; fuel?: string[] };
  basis?: string;
}

export interface ParameterRow {
  target: string;
  label: string;
  type: string;
  parameter: string;
  value: number;
  unit: string;
  source: string;
  reference: string;
}

export interface OverrideEntry {
  target: string;
  parameter: string;
  value: number;
  unit: string;
  source: string;
  provenance: 'measured' | 'manufacturer' | 'estimated';
  uncertainty?: number | null;
  date?: string | null;
}

export type SweepMetric =
  | 'total_impulse_Ns' | 'burn_time_s' | 'mean_thrust_N' | 'pc_mean_psia' | 'of_mean'
  | 'ox_min_psia' | 'fuel_min_psia' | 'ox_stiffness_min' | 'fuel_stiffness_min' | 'copv_end_psia';

export interface SweepCase {
  label: string;
  ok: boolean;
  error?: string;
  /** The case tripped the stand (it is not in the swings; it is a crossing). */
  tripped?: TrippedRecord;
  breaks?: string[];
  metrics?: Record<SweepMetric, number | null>;
  delta?: Record<SweepMetric, number | null>;
  thrust?: [number, number][];
}

export interface SweepFactor {
  key: string;
  label: string;
  group: 'feed' | 'engine' | 'operation';
  basis: string;
  cases: Record<string, SweepCase>;
  swing: Record<SweepMetric, number | null>;
}

export interface SweepResult {
  nominal: Record<SweepMetric, number | null>;
  nominal_thrust: [number, number][];
  factors: SweepFactor[];
  band: Record<SweepMetric, number | null>;
  /** The band each way (sweeps before 2026-10-02 lack them). */
  band_low?: Record<SweepMetric, number | null>;
  band_high?: Record<SweepMetric, number | null>;
  /** Cases that break a limit at the end of their range. */
  crossings?: { factor: string; side: string; case: string; breaks: string[]; tripped?: boolean }[];
  notes: string[];
  cases: number;
  workers: number;
  wall_s: number;
  basis: string;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RunView {
  id: string;
  /** 'trade' is legacy: the study was removed; its saved jobs are still listed and readable (``legacy``). */
  kind?: 'run' | 'uncertainty' | 'optimize' | 'reconcile' | 'setpoint' | 'hardware' | 'trade';
  /** A job of a kind that can no longer be started (the server marks it at read time). Read-only. */
  legacy?: boolean;
  status: RunStatus;
  stage: string;
  progress: number;
  error: string | null;
  started: number;
  finished: number | null;
  design: string;
  settings: LayerXSettings;
  result?: LayerXResult | SweepResult | OptimizeResult | ReconcileResult | SetpointResult | HardwareResult | null;
  summary?: Summary | null;
  drawing?: Provenance['drawing'] | null;
  /** What the person said about it (PATCH /runs/{id}). */
  meta?: RunMeta | null;
}

export interface RunMeta { name?: string; note?: string; pinned?: boolean }

export interface LayerXStatus {
  feedtwin: { available: boolean; version: string | null; error: string | null };
  shipped_drawings: string | null;
  state_machines: string | null;
  pid_designer_url: string;
  max_jobs: number;
}

export interface PidDocument {
  id: string;
  name: string;
  owner: string;
  updated_at: string;
  mine: boolean;
}

type Result<T> = { data?: T; error?: string; status?: number };

/** The rail's names for the settings, so a refused value reads as the field the person typed in. */
const FIELD_NAME: Record<string, string> = {
  tank_pressure_psia: 'Tank pressure (psia)', copv_pressure_psig: 'Bottle fill (psig)', fill_fraction: 'Fill fraction',
  dry_kg: 'Unusable propellant (kg)', chilldown: 'Tank wall heat transfer', hold_s: 'Loaded before T-0 (s)', dt: 'Time step (s)',
  horizon_s: 'Max burn (s)', liftoff_mass_kg: 'Liftoff mass (kg)', drawing_id: 'Drawing', thrust_N: 'Thrust (N)', of: 'O/F',
  lo: 'from', hi: 'to', n: 'points', x: 'sweep', y: 'and', settings: '',
};

export function errorText(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail;
  // FastAPI's validation errors: [{loc: ['body', 'fill_fraction'], msg: 'Input should be less than 0.99'}, ...]
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      const e = d as { loc?: unknown[]; msg?: string };
      const where = (e.loc ?? []).filter((x) => x !== 'body')
        .map((x) => (typeof x === 'string' && x in FIELD_NAME ? FIELD_NAME[x] : String(x))).filter(Boolean).join(' ');
      return `${where ? `${where}: ` : ''}${(e.msg ?? 'invalid').replace(/^Value error, /, '')}`;
    });
    if (parts.length) return parts.join('; ');
  }
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: string; failing?: string[] };
    if (d.message) return d.failing?.length ? `${d.message} ${d.failing.join('; ')}` : d.message;
  }
  return `HTTP ${status}`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const headers: Record<string, string> = init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
    const response = await fetch(`${API_BASE}/layerx${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { error: errorText((body as { detail?: unknown }).detail, response.status), status: response.status };
    return { data: body as T };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ------------------------------------------------------------------ phase 4: the optimiser

export type OptimizeObjective = 'impulse' | 'apogee';

export interface OptVariable {
  key: 'lockup_psia' | 'copv_psig' | 'copv_volume_L';
  label: string;
  unit: string;
  lo: number;
  hi: number;
  start: number;
  enabled: boolean;
  basis: string;
}

export interface OptimizeBody {
  settings: LayerXSettings;
  objective: OptimizeObjective;
  variables: Record<string, { enabled: boolean; lo: number; hi: number }>;
  dropout_margin_psi: number;
  stiffness: boolean;
  of_band_rel: number | null;
  max_evaluations: number;
}

export interface OptConstraint {
  key: string;
  label: string;
  ok: boolean;
  value?: number;
  limit?: number;
  kind?: 'min' | 'max';
  unit?: string;
  violation?: number;
  detail?: string;
}

export interface OptFigures {
  total_impulse_Ns: number | null;
  impulse_to_depletion_Ns: number | null;
  burn_time_s: number | null;
  depletion_s: number | null;
  mean_thrust_N: number | null;
  pc_mean_psia: number | null;
  of_mean: number | null;
  isp_mean_s: number | null;
  copv_end_psia: number | null;
  ox_stiffness_min: number | null;
  fuel_stiffness_min: number | null;
  ox_residual_kg: number | null;
  fuel_residual_kg: number | null;
  depleted_side: string | null;
  apogee_agl_m?: number;
  max_velocity_m_s?: number;
  max_accel_g?: number;
}

export interface OptEvaluation {
  index: number;
  iteration: number;
  x: Record<string, number>;
  ok: boolean;
  error?: string;
  preflight: string[];
  figures: OptFigures | null;
  lockup_psia?: number;
  dome_psig?: number;
  objective: number | null;
  violation: number | null;
  constraints: OptConstraint[];
  wall_s: number;
}

// ------------------------------------------------------------------ the injector reconciler

export interface ReconcileBody {
  settings: LayerXSettings;
  thrust_N?: number | null;
  of?: number | null;
  hold_spray_direction?: boolean;
  max_passes?: number;
}

/** Forward mode at the lockup (engine/layerx/reconcile.py _forward). */
export interface ReconcilePoint {
  thrust_N: number; of: number; pc_psia: number; isp_s: number; mdot_O: number; mdot_F: number;
  dp_O_psi: number | null; dp_F_psi: number | null; stiffness_O: number | null; stiffness_F: number | null;
  momentum_ratio: number | null; tilt_deg: number | null;
  d_O_mm: number; d_F_mm: number; angle_O_deg: number; angle_F_deg: number;
}

export interface ReconcileBurn {
  mean_thrust_N: number | null; pc_mean_psia: number | null; of_mean: number | null;
  total_impulse_Ns: number | null; burn_time_s: number | null;
}

export interface DrillChoice { drill: string; d_mm: number; area_error: number }

/** Forward mode through the fitted feed for one pairing of drills. */
export interface DrillPair {
  oxidizer: string; fuel: string; d_O_mm: number; d_F_mm: number;
  thrust_N: number; of: number; pc_psia: number; stiffness_O: number | null; stiffness_F: number | null;
  momentum_ratio: number | null; tilt_deg: number | null;
}

export interface ReconcileChange {
  item: string; unit: string; from: number; to: number; delta: number; fabrication: string;
  drills?: { number?: DrillChoice; metric?: DrillChoice };
}

export interface ReconcileResult {
  config_sha256: string;
  condition: string;
  lockup_psia: number;
  target: { thrust_N: number; of: number; source: string };
  design: ReconcilePoint;
  before: ReconcilePoint;
  after: ReconcilePoint;
  before_burn: ReconcileBurn;
  after_burn: ReconcileBurn;
  passes: { pass: number; burn: ReconcileBurn; K0_O: number; K0_F: number;
            thrust_error: number | null; d_O_mm: number; d_F_mm: number; change: number; newton_iterations: number }[];
  converged: boolean;
  changes: ReconcileChange[];
  drill_options: Record<'oxidizer' | 'fuel', DrillChoice[]>;
  drill_grid: DrillPair[];
  passage_length_m: Record<'oxidizer' | 'fuel', number | null>;
  angles: Record<'oxidizer' | 'fuel', number>;
  band: Record<string, (number | null)[]>;
  design_update: Record<string, unknown>;
  notes: string[];
  wall_s: number;
  basis: string;
}

export interface OptimizeResult {
  objective: OptimizeObjective;
  request: { dropout_margin_psi: number; stiffness: boolean; of_band_rel: number | null; max_evaluations: number };
  variables: OptVariable[];
  card_center_psia: number;
  start: OptEvaluation | null;
  best: OptEvaluation;
  history: OptEvaluation[];
  verified: { best?: OptEvaluation & { error?: string }; start?: OptEvaluation & { error?: string } } | null;
  notes: string[];
  evaluations: number;
  workers: number;
  wall_s: number;
  basis: string;
}

// ------------------------------------------------------------------ set point and hardware (the rebuilt Optimize)

/** Per tank side, a maximum expected operating pressure across the wall [psi]. */
export type MeopPsi = Partial<Record<'oxidiser' | 'fuel', number>>;

/** POST /setpoint: the dome, lockup and fill for a target mean thrust (engine/layerx/setpoint.py). */
export interface SetpointBody {
  settings: LayerXSettings;
  /** null: the design's design_requirements.target_thrust. */
  target_thrust_N?: number | null;
  thrust_tol_rel?: number;
  solve_fill?: boolean;
  margin_psi?: number;
  margin_tol_psi?: number;
  meop_psi?: MeopPsi | null;
  design_of?: number | null;
  max_burns?: number;
  replay?: boolean;
  verify?: boolean;
}

export type HardwareObjective = 'target_thrust_error' | 'thrust_flatness' | 'of_error' | 'impulse' | 'bottle_margin';

/** POST /hardware: catalogue parts for the components marked free (engine/layerx/optimize.py run_hardware). */
export interface HardwareBody {
  settings: LayerXSettings;
  /** {target: 'node:SV_LOX_PRESS' | 'edge:l_ox1' | 'design:oxidizer.d_jet', kind?: 'trim_orifice', rows?: catalogue ids}. */
  components: { target: string; kind?: string; rows?: string[] }[];
  objective?: HardwareObjective;
  target_thrust_N?: number | null;
  design_of?: number | null;
  neighbours?: number;
  combine?: boolean;
  max_candidates?: number;
  margin_psi?: number;
  meop_psi?: MeopPsi | null;
  verify?: boolean;
  trim_C?: number | null;
}

export type ChangeDomain = 'operation' | 'drawing' | 'design' | 'model';
export type CadImpact = 'none' | 're-drill' | 'new plate' | 'new part' | 'setting only';

/** One change a tool proposes (engine/layerx/diff.py, schema layerx.change-list/1). */
export interface ChangeRecord {
  component: string;
  pid_node_id: string | null;
  field: string;
  before: number | string | null;
  after: number | string | null;
  unit: string;
  provenance: string;
  /** After minus before, per graded figure, from the verifying burn. */
  effect: Record<string, number | null>;
  effect_basis?: string;
  cad_impact: CadImpact;
  target: string;
  domain: ChangeDomain;
  label?: string;
  source?: string;
  before_provenance?: string | null;
  catalog?: Record<string, unknown> | null;
  drill?: Record<string, unknown> | null;
  note?: string | null;
}

export interface ChangeList {
  schema: 'layerx.change-list/1' | string;
  tool: 'setpoint' | 'hardware' | 'reconcile' | string;
  changes: ChangeRecord[];
  effects: { key: string; label: string; unit: string; before: number | null; after: number | null; delta: number | null }[];
  basis?: Record<string, unknown>;
  notes?: string[];
  needs_pid_designer?: unknown[];
  counts?: Partial<Record<ChangeDomain, number>>;
  exports?: { settings_patch?: Partial<LayerXSettings>; design_write?: Record<string, unknown>; pid_designer?: Record<string, unknown> };
}

/** A graded limit (DATA-CONTRACT 1); the GUI's richer type is components/lx/contract.ts ServerLimit. */
export interface LimitRow {
  key: string; label: string; group?: string; value: number | null; unit?: string;
  limit?: number | null; warn?: number | null; direction?: 'min' | 'max'; grade: 'ok' | 'warn' | 'bad' | 'info';
  t_worst?: number | null; index_worst?: number | null; series_ref?: string | null; basis?: string; hint?: string;
  decision?: string; review_pending?: boolean; capped_from?: string;
}

export interface SetpointResult {
  mode: 'setpoint';
  target: { mean_thrust_N: number; source: string; tol_rel?: number; margin_psi?: number };
  converged: boolean;
  fill_status?: string;
  feasible: boolean;
  /** What a person dials: gauge pressures, said in the key names. */
  settings_card: {
    dome_psig?: number; lockup_psia?: number; copv_fill_psig?: number; dome_per_1000psi_fill?: number;
    full_bottle_psig?: number; dome_at_full_bottle_psig?: number; fuel_lead_s?: number | null; fuel_lead?: string;
    [k: string]: unknown;
  };
  solution: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  of?: { settable_here: false; [k: string]: unknown };
  limits: LimitRow[];
  limits_basis?: string;
  binding?: unknown;
  history: Record<string, unknown>[];
  change_list?: ChangeList;
  model?: Record<string, unknown>;
  unmeasured?: unknown[];
  notes?: string[];
  burns: number;
  summary?: { mean_thrust_N?: number; total_impulse_Ns?: number; burn_time_s?: number; of_mean?: number;
              lockup_psia?: number; dome_psig?: number; copv_psig?: number; feasible?: boolean };
  wall_s?: number;
  workers?: number;
  basis?: string;
}

export interface HardwareResult {
  mode: 'hardware';
  objective: HardwareObjective;
  components: unknown[];
  baseline: Record<string, unknown>;
  candidates: { rank: number; figures?: Record<string, unknown>; limits_bad?: number; trim?: Record<string, unknown>; [k: string]: unknown }[];
  winner: Record<string, unknown> | null;
  improves: boolean;
  setpoint?: SetpointResult | Record<string, unknown> | null;
  final?: Record<string, unknown> | null;
  change_list?: ChangeList;
  needs_pid_designer?: unknown[];
  catalog_problems?: string[];
  model?: Record<string, unknown>;
  trim_model?: Record<string, unknown>;
  target?: Record<string, unknown>;
  summary?: Record<string, unknown> | string;
  burns?: number;
  wall_s?: number;
  workers?: number;
  basis?: string;
}

/** GET /runs/{id}/export/{fmt}: every signal (csv, parquet) or the FEA load bundle (a zip). */
export type ExportFormat = 'csv' | 'parquet' | 'fea';
export const layerxExportUrl = (runId: string, fmt: ExportFormat) =>
  `${API_BASE}/layerx/runs/${encodeURIComponent(runId)}/export/${fmt}`;

export const layerx = {
  status: () => call<LayerXStatus>('/status'),
  drawings: () => call<Drawing[]>('/drawings'),
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<Drawing>('/drawings', { method: 'POST', body: form });
  },
  pidDocuments: () => call<{ reachable: boolean; url: string; error?: string; documents: PidDocument[] }>('/pid-designer'),
  pidImport: (doc: { id: string; owner?: string; release?: string; name?: string }) =>
    call<Drawing>('/pid-designer/import', { method: 'POST', body: JSON.stringify(doc) }),
  preflight: (settings: LayerXSettings) => call<Preflight>('/preflight', { method: 'POST', body: JSON.stringify(settings) }),
  start: (settings: LayerXSettings) => call<{ id: string; status: RunStatus }>('/runs', { method: 'POST', body: JSON.stringify(settings) }),
  runs: () => call<RunView[]>('/runs'),
  parameters: (drawingId: string) =>
    call<{ rows: ParameterRow[]; overrides: OverrideEntry[] }>(`/drawings/${encodeURIComponent(drawingId)}/parameters`),
  putMeasurements: (drawingId: string, overrides: OverrideEntry[]) =>
    call<{ overrides: OverrideEntry[] }>(`/drawings/${encodeURIComponent(drawingId)}/measurements`, { method: 'PUT', body: JSON.stringify({ overrides }) }),
  startUncertainty: (settings: LayerXSettings) => call<{ id: string; kind: string; status: RunStatus }>('/uncertainty', { method: 'POST', body: JSON.stringify(settings) }),
  optimizeVariables: (settings: LayerXSettings) =>
    call<{ variables: OptVariable[]; stiffness_band: Record<string, number[] | null> | null; design_of: number | null }>(
      '/optimize/variables', { method: 'POST', body: JSON.stringify(settings) }),
  startOptimize: (body: OptimizeBody) => call<{ id: string; kind: string; status: RunStatus }>('/optimize', { method: 'POST', body: JSON.stringify(body) }),
  /** The live design with an injector what-if written in, as a YAML file. */
  exportConfig: async (body: { design_patch?: DesignPatch | null; feed_system?: Record<string, unknown> | null; name: string; note?: string }):
    Promise<Result<{ text: string; filename: string }>> => {
    try {
      const response = await fetch(`${API_BASE}/layerx/export-config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { error: errorText((err as { detail?: unknown }).detail, response.status), status: response.status };
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'design.yaml';
      return { data: { text: await response.text(), filename: name } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Network error' };
    }
  },
  startReconcile: (body: ReconcileBody) => call<{ id: string; kind: string; status: RunStatus }>('/reconcile', { method: 'POST', body: JSON.stringify(body) }),
  startSetpoint: (body: SetpointBody) => call<{ id: string; kind: string; status: RunStatus }>('/setpoint', { method: 'POST', body: JSON.stringify(body) }),
  startHardware: (body: HardwareBody) => call<{ id: string; kind: string; status: RunStatus }>('/hardware', { method: 'POST', body: JSON.stringify(body) }),
  /** The parts Hardware mode chooses from: {<kind>: rows, drills, problems} (engine/layerx/catalog.py). */
  catalog: () => call<Record<string, unknown> & { drills: unknown[]; problems: string[] }>('/catalog'),
  /** A finished run's large side data; 404 (status) when the run has none. */
  sidecar: <T = Record<string, unknown>>(id: string, name: 'axial') =>
    call<T>(`/runs/${encodeURIComponent(id)}/sidecar/${name}`),
  run: (id: string) => call<RunView>(`/runs/${encodeURIComponent(id)}`),
  daqChannels: () => call<{ available: boolean; path: string; channels: DaqChannel[]; error?: string }>('/daq-channels'),
  channels: (drawingId: string) => call<{ channels: Record<string, string> }>(`/drawings/${encodeURIComponent(drawingId)}/channels`),
  putChannels: (drawingId: string, channels: Record<string, string>) =>
    call<{ channels: Record<string, string> }>(`/drawings/${encodeURIComponent(drawingId)}/channels`, { method: 'PUT', body: JSON.stringify({ channels }) }),
  annotate: (id: string, meta: RunMeta) =>
    call<RunMeta>(`/runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(meta) }),
  deleteRun: (id: string) => call<{ id: string; deleted: boolean }>(`/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  cancel: (id: string) => call<{ id: string; status: string }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  /** A finished burn's thrust curve as an OpenRocket .eng file (engine/layerx/eng.py). */
  exportEng: async (id: string): Promise<Result<{ text: string; filename: string }>> => {
    try {
      const response = await fetch(`${API_BASE}/layerx/runs/${encodeURIComponent(id)}/eng`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return { error: errorText((body as { detail?: unknown }).detail, response.status), status: response.status };
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'layerx.eng';
      return { data: { text: await response.text(), filename: name } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Network error' };
    }
  },
};

/**
 * TypeScript mirror of `physics/schema.py`.
 *
 * PLAN.md §11.11 item 1: the Pydantic models are the contract both sides build
 * against. This file is the other side of it. Field names match the Python
 * exactly -- `CdS` not `cds`, `m_c` not `mc`, `h_a` not `apogee` -- because
 * there is deliberately no translation layer (§11.7): the GUI serialises what
 * the CLI accepts, byte-identically.
 *
 * Every Pydantic model there sets `extra="forbid"`. That is the reason for the
 * `Ui*` split below: the editor needs bookkeeping the physics must never see
 * (a stable React key, which fields came from the catalog), and posting those
 * would be a 422, not a silently ignored field. `toWireConfig` in
 * `lib/serialise.ts` is the only place allowed to cross that line.
 *
 * The `Config` half of this file is settled -- schema.py exists. The `Result`
 * half is NOT: the physics agent has not written those models yet, so what is
 * here is the frontend's proposal, built to be plausible enough to lay out
 * against and reconciled when the real thing lands. Anything under RESULT is
 * provisional; anything under CONFIG is not.
 */

import type { Kind } from '../lib/quantities'

// ============================================================================
// CONFIG -- mirrors schema.py, settled
// ============================================================================

export type TriggerKind = 'ALTITUDE' | 'TIME'

export interface Trigger {
  kind: TriggerKind
  /** Altitude AGL in m for ALTITUDE; seconds after apogee for TIME (§4.0). */
  value: number
}

export interface Device {
  name: string
  /** Full-open drag area, m². One atomic symbol -- never factored (§1.2). */
  CdS: number
  /** Nominal diameter, m. Enters only through filling distance, eq (9). */
  D0: number
  /** Canopy + lines + bag, kg. The bag rides canopy-side of the harness. */
  m_c: number
  /** Area growth exponent: 2 solid cloth, 1 slotted. */
  j: number
  /** Filling constant, diameters fallen. Swept 6-12; coupled to j. */
  n: number
  /** Opening force coefficient, eq (23). Dominant uncertainty (§15.7). */
  Cx: number
  trigger: Trigger
  /** Charge-to-line-stretch lag, s. +55% on drogue load at 0.5 s (§6.1.3). */
  delay: number
  /** Series harness stiffness, N/m, eq (32). Snatch is skipped if null. */
  k_eff: number | null
  /** Separation velocity at line stretch, m/s. NOT the descent speed. */
  v_rel: number
}

export interface Vehicle {
  m: number
  h_a: number
  d_body: number
  l_body: number
  /* No CdS_body: airframe drag area is DERIVED from d_body and l_body via
   * eqs (14)/(15). It is not an input because §6.4 does not permit collapsing
   * the axial/broadside band to one value -- 36x in the input, 2.1x on the
   * design load -- and because a typed value can silently disagree with the
   * geometry above it. Posting one is a 422. */
  z0: number | null
  v0: number | null
}

/**
  * Pad conditions. Elevation is deliberately NOT here: the project models one
  * range, so `physics/site.py` owns it as a constant and `extra="forbid"`
  * turns a posted `z_site` into a 422 rather than a silently ignored value.
  */
export interface Site {
  /** Measured pad temperature, K. Worth ~7% in density. */
  T_pad: number | null
  /** Pad station pressure, Pa. Never a raw METAR altimeter setting. */
  p_pad: number | null
  /**
   * Lapse rate over the flight band, K per METRE (not K/km), negative for a
   * cooling column. Null keeps the standard re-fit, which infers the slope
   * from the pad temperature alone; a measured monthly value replaces that
   * inference with an observation.
   */
  lapse: number | null
}

export interface Hardware {
  safety_factor: number
  /** Rated strength per load-path element, N. Named so the report can say
   *  which link governs -- it is rarely the shock cord. */
  links: Record<string, number>
}

/** One entry of the corner sweep, as schema.py's `SweepParam` wants it.
 *  Note `low`/`high`, not the UI's `min`/`max`: the UI carries presentation
 *  fields (label, unit) the backend forbids, so the two are separate types and
 *  `toWireConfig` is the one place that maps between them. */
export interface WireSweepParam {
  key: string
  enabled: boolean
  low: number
  high: number
}

/** How a study axis enumerates its values. `linear` is start/stop/points with
 *  BOTH ends inclusive; `list` writes them out. */
export type StudyMode = 'linear' | 'list'

/** One catalogue row as a design point. The values travel explicitly rather
 *  than as a SKU the backend looks up, so `physics/` never needs the catalogue
 *  and a saved study cannot change meaning when `parachutes.csv` is rescraped.
 *  `label` is what the chart and table say -- `CdS = 3.889` is not something a
 *  reader can match back to "Iris Ultra 60". */
export interface WireCanopy {
  label: string
  CdS: number
  D0: number
  m_c: number
  j: number
}

/** One variable of a design study. Mirrors `schema.StudyAxis`.
 *
 *  Note this is NOT `WireSweepParam`: that one carries two corners of an
 *  unmeasured parameter applied in common across every device, this one
 *  carries a grid of a chosen parameter applied to one named device. */
export interface WireStudyAxis {
  key: string
  /** Device NAME, required for a per-device key and forbidden for a vehicle
   *  one. By name rather than index so removing a device cannot silently
   *  retarget the axis at a different one. */
  device: string | null
  enabled: boolean
  mode: StudyMode
  start: number | null
  stop: number | null
  points: number | null
  values: number[] | null
  canopies: WireCanopy[] | null
}

export interface Config {
  vehicle: Vehicle
  site: Site
  devices: Device[]
  hardware: Hardware | null
  sweep: WireSweepParam[] | null
  /** The design study. Rides on the config for the same reasons `sweep` does:
   *  one body schema across /simulate, /sweep and /study, and Save config
   *  round-trips it. Null and [] mean the same thing -- unlike `sweep`, there
   *  is no canonical default study to fall back to. */
  study: WireStudyAxis[] | null
}

// ============================================================================
// UI STATE -- never serialised as-is
// ============================================================================

/**
 * How the pad state is resolved. PLAN.md §11.3 offers three sources; the wire
 * format carries only the resulting numbers, so this stays UI-side.
 *
 * `metar` and `climatology` are both "from a station" but answer different
 * questions. A METAR is the observation issued in the last hour -- it has no
 * month, and it is the right choice on launch day. `climatology` is the ten
 * year monthly mean for the same station, which is what a design case wants,
 * and it is the only source that shares the month with the temperature
 * profile.
 */
export type PadSource = 'isa' | 'barometer' | 'metar' | 'climatology'

/** Which fields a catalog pick filled in, so the badge can be drawn and a
 *  manual override can show the vendor value it replaced (§11.3). */
export interface CatalogProvenance {
  sku: string
  vendor: string
  /** Vendor's value for each auto-filled field, kept even after an override. */
  values: Partial<Record<'CdS' | 'D0' | 'm_c' | 'j', number>>
  /** Fields the user has since typed over. */
  overridden: string[]
}

export interface UiDevice extends Device {
  /** Stable React key. Not part of the wire format. */
  uid: string
  /**
   * True when Cx and n came from flight data rather than the unmeasured
   * bands (§14 item 4). UI-only: the wire format carries the numbers, not
   * their provenance, so this must be stripped by `toWireDevice`.
   */
  measured: boolean
  catalog: CatalogProvenance | null
  /** Collapsed cards keep the device list readable at 4+ devices. */
  collapsed: boolean
}

/** Where the temperature profile's slope comes from. */
export type TempProfile = 'standard' | 'measured'

export interface UiSite extends Site {
  source: PadSource
  /** Which METAR station to resolve from, when source is 'metar'. */
  station: string
  /** UI-only: which profile the user picked. The wire format carries only the
   *  resulting `lapse` number, not how it was chosen. */
  profile: TempProfile
  /**
   * UI-only: the calendar month, shared by the measured lapse rate and the
   * monthly-normal pad state.
   *
   * One field rather than two on purpose -- a run that took its pressure from
   * January and its lapse rate from July would be an atmosphere that never
   * existed, and nothing downstream could detect it.
   */
  month: number
}

export interface UiHardware extends Hardware {
  /** §4.2 makes hardware optional; unticked means `hardware: null`. */
  enabled: boolean
}

/** Which parameters to corner-sweep, and over what bounds (§11.3). Not in
 *  schema.py yet -- the sweep endpoint is separate from simulate. */
export interface SweepParam {
  key: string
  label: string
  enabled: boolean
  /** SI, like everything else stored. `kind` decides how it is shown. */
  min: number
  max: number
  /** The quantity, for rows that have one. Rows without -- Cx, n, delay --
   *  are dimensionless or in seconds and fall back to `unit`. */
  kind?: Kind
  unit: string
}

/**
 * One design-study axis as the editor holds it.
 *
 * Every numeric field is SI, like everything else stored -- `lib/study.ts`
 * declares the `Kind` and `AxisEditor` converts at the input boundary. The
 * only addition over the wire shape is `uid`, a stable React key: axes have no
 * natural identity (two `CdS` axes on different devices are both "CdS"), and
 * keying by index makes the wrong row lose focus when one above it is deleted.
 */
export interface UiStudyAxis {
  uid: string
  key: string
  device: string | null
  enabled: boolean
  mode: StudyMode
  start: number | null
  stop: number | null
  points: number | null
  values: number[] | null
  canopies: WireCanopy[] | null
}

export interface UiConfig {
  vehicle: Vehicle
  site: UiSite
  devices: UiDevice[]
  hardware: UiHardware
  sweep: SweepParam[]
  /** Empty by default. Which designs are worth comparing is not something the
   *  tool can guess, so unlike `sweep` there is no canonical starting set. */
  study: UiStudyAxis[]
}

// ============================================================================
// RESULT -- PROVISIONAL, see the file header
// ============================================================================

/** PLAN.md §11.5. Computed on every run, never behind a button. */
export type CaseId = 'nominal' | 'simultaneous' | 'no_main' | 'no_drogue'

export const CASE_IDS: CaseId[] = ['nominal', 'simultaneous', 'no_main', 'no_drogue']

/** Each case fails in a *different category*, so no single PASS/FAIL covers
 *  them (§11.5). The summary names the category rather than emitting a bare
 *  verdict. */
export type FailureCategory = 'structure' | 'impact' | 'drift' | 'none'

export const CASE_META: Record<CaseId, {
  label: string
  short: string
  /** What this case is. */
  detail: string
  /** The metric that decides whether this case is acceptable -- §11.5's
   *  second table. Every case reports all four figures; this names the one
   *  that carries the verdict for this case. */
  metric: string
  category: FailureCategory
  colour: string
}> = {
  nominal: {
    label: 'Nominal',
    short: 'NOM',
    detail: 'Drogue at its trigger, main at its altitude.',
    metric: 'all',
    category: 'none',
    colour: 'var(--case-nominal)',
  },
  simultaneous: {
    label: 'Simultaneous',
    short: 'SIM',
    detail: "Main fires at the drogue's trigger time, near apogee.",
    metric: 'descent time and drift',
    category: 'drift',
    colour: 'var(--case-simultaneous)',
  },
  no_main: {
    label: 'Main fails',
    short: 'NO MAIN',
    detail: 'Descends under drogue alone to the ground.',
    metric: 'impact velocity and impact energy (KE_impact)',
    category: 'impact',
    colour: 'var(--case-no-main)',
  },
  no_drogue: {
    label: 'Drogue fails',
    short: 'NO DROGUE',
    detail: 'Main opens out of ballistic free fall.',
    metric: 'max load (F_peak) against the allowable (F_allow)',
    category: 'structure',
    colour: 'var(--case-no-drogue)',
  },
}

/** One row of `trajectory.csv` (§11.4). */
export interface TrajectorySample {
  t: number
  z: number
  v: number
  a: number
  F_T: number
  CdS_tot: number
}

export type EventKind =
  | 'start'
  | 'trigger'
  | 'line_stretch'
  | 'inflation_start'
  | 'inflation_end'
  | 'ground'

export interface FlightEvent {
  t: number
  kind: EventKind
  device: string | null
  z: number
  v: number
  label: string
}

/** Per-device opening loads. eqs (19)-(37). */
export interface DeviceLoads {
  device: string
  /** Snatch velocity, eq: |v| at line stretch. */
  v_s: number
  /** Ballistic parameter A, eq (25). */
  A: number
  /** Opening-load factor X1, eq (29). */
  X1: number
  /** Infinite-mass bound, eq (23). */
  F_inf: number
  /** Finite-mass peak, F_inf * X1. */
  F_peak: number
  /** Snatch load, eq (34). Null when k_eff was not supplied. */
  F_snatch: number | null
  /** Inflation duration, eq (10). */
  t_fill: number
  /** True when v_s is below sqrt(g*s_f) and eq (23) is not a bound (§8.2). */
  below_validity_floor: boolean
}

export interface CaseResult {
  case: CaseId
  trajectory: TrajectorySample[]
  events: FlightEvent[]
  device_loads: DeviceLoads[]
  descent_time: number
  impact_velocity: number
  impact_ke: number
  /** Eq (39), the intuitive form: the drop height that matches the impact. */
  h_equiv: number
  /** Max harness tension over the whole descent, N. */
  F_max: number
  /** Eq (36) max over snatch, F_inf and Cx*F_T, BEFORE the safety factor --
   *  the load the hardware actually sees, and what `status` compares against
   *  F_allow. This is the headline figure; F_design is it times a margin. */
  F_peak_max: number
  /** The margin applied to reach F_design. Sent so the GUI can state the
   *  relationship instead of inferring it by division. */
  safety_factor: number
  /** Eq (37) design load, F_peak_max * safety_factor. */
  F_design: number
  /** PASS/FAIL for THIS case's own category. 'na' without hardware (§4.2). */
  status: 'pass' | 'fail' | 'na'
  /** Which link governs, when hardware is declared. */
  governing_link: string | null
}

export interface Result {
  schema_version: string
  /** §11.4: which version of the physics produced this. */
  git_sha: string
  generated: string
  /** Echo of the exact input, so a Result reloads reproducibly. */
  config: Config
  /** §11.7 warnings travel as data -- the run still happens. */
  warnings: string[]
  /** Every case, every run (§11.5). */
  cases: Record<CaseId, CaseResult>
  /** Resolved pad state, so the report can state what atmosphere was used. */
  pad: {
    p_pad: number
    T_pad: number
    rho_pad: number
    source: string
    /** eq (7) re-fit lapse rate, K/m. */
    lapse: number
  }
  /** Non-null only when the §6.4 band was run both ways. */
  body_drag_band: { axial: number; broadside: number } | null
}

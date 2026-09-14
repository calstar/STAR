/**
 * The API client. Every quantity arrives in a named unit; nothing here converts.
 *
 * Artifacts are addressed by the hash of their own bytes, so an id names one
 * specific drawing or engine config forever — which is what makes a result
 * reproducible a year later.
 */

export interface Artifact {
  id: string;
  kind: 'diagram' | 'engine';
  name: string;
  sha256: string;
  size: number;
  imported_at: string;
  source: string;
  notes: string;
  summary: Record<string, unknown>;
}

export interface ImportResult {
  artifact: Artifact;
  already_present: boolean;
}

export interface Symbol {
  id: string;
  tag: string;
  type: string;
  x: number;
  y: number;
  fluid: string;
  role: string;
}

export interface Line {
  id: string;
  source: string;
  target: string;
  kind: string;
  fluid: string;
}

export interface Actuator {
  id: string;
  tag: string;
  signal: string;
}

export interface ControlSpec {
  key: string;
  label: string;
  unit: string;
  default: number;
  minimum: number;
  maximum: number;
  step: number;
  note: string;
}

export interface Assumption {
  component: string;
  parameter: string;
  value: number;
  unit: string;
  source: string;
  reference: string;
}

export interface Report {
  diagram: string;
  engine: string;
  coupled: boolean;
  symbols: number;
  lines: number;
  nodes: number;
  branches: number;
  instruments: number;
  actuators: number;
  unchecked: number;
  assumptions: Assumption[];
  warnings: string[];
}

export interface ModelView {
  diagram_id: string;
  engine_id: string;
  title: string;
  symbols: Symbol[];
  lines: Line[];
  actuators: Actuator[];
  controls: ControlSpec[];
  fluid_sets: string[];
  report: Report;
  engine: Record<string, unknown>;
}

export interface EngineState {
  chamber_psi: number;
  mdot_ox: number;
  mdot_fuel: number;
  mixture_ratio: number;
  chamber_temperature_K: number;
  cstar: number;
  thrust_N: number;
  isp_s: number;
  outside_table: boolean;
}

export interface Frame {
  t: number;
  pressure_psi: Record<string, number>;
  node_psi: Record<string, number>;
  flow_kg_s: Record<string, number>;
  open: Record<string, boolean>;
  engine: EngineState | null;
}

export interface Channel {
  id: string;
  tag: string;
  unit: string;
  values: number[];
}

/** A sibling design tool this instance can import from. */
export interface Source {
  key: string;
  label: string;
  kind: 'diagram' | 'engine';
  base_url: string;
  reachable: boolean;
  detail: string;
}

/** One design in a sibling tool's store. */
export interface SourceDocument {
  id: string;
  name: string;
  owner: string;
  owner_name: string;
  updated_at: string;
  mine: boolean;
  releases: string[];
}

export interface Leg {
  propellant: string;
  mdot_kg_s: number;
  density: number;
  area_mm2: number;
  cd: number;
  injector_dp_psi: number;
  feed_loss_psi: number;
  /** Injector pressure drop as a fraction of chamber pressure. */
  stiffness: number;
  /** The band this side was designed to, from the engine config's own
   *  `injector_dp_ratio_*`. Zero means it stated none. */
  band_min: number;
  band_max: number;
  velocity_m_s: number;
}

/**
 * Why the mixture ratio is what it is.
 *
 * `mixture_ratio === face_ratio * feed_term` exactly — the orifice law makes it
 * an identity, not a fit. So the two terms split the blame cleanly: the face
 * ratio is the injector's, the feed term is the stand's.
 */
export interface Balance {
  mixture_ratio: number;
  face_ratio: number;
  feed_term: number;
  design_ratio: number;
  design_error: number;
  residual: number;
  chamber_psi: number;
  trim_psi: number;
  oxidiser: Leg;
  fuel: Leg;
  notes: string[];
}

/** The stand's states, and how they bind to this drawing's valves. */
export interface StateMachine {
  name: string;
  states: string[];
  /** State -> the states reachable from it. */
  transitions: Record<string, string[]>;
  actuators: string[];
  /** State-machine actuator -> drawing symbol id. */
  bound: Record<string, string>;
  /** Actuators with no symbol on this drawing. A main valve here is serious. */
  unmatched: string[];
  /** Drawing valves nothing commands; they hold whatever you set. */
  uncommanded: string[];
  /** `positions[state][symbolId]` — already translated into drawing ids. */
  positions: Record<string, Record<string, boolean>>;
  /** Problems in the state tables themselves. */
  warnings: string[];
}

/** A propellant tank's inventory. */
export interface TankState {
  id: string;
  label: string;
  pressure_psi: number;
  ullage_temperature_K: number;
  liquid_mass_kg: number;
  liquid_temperature_K: number;
  fill_fraction: number;
  level_m: number;
  /** The metal under the liquid [K]. Warm on a LOX tank means it is still
   *  chilling down and will boil hard if the vent shuts. */
  wall_temperature_K?: number;
  surface_temperature_K?: number;
  /** What the drawing says the vessel holds [L]. */
  volume_L?: number;
}

/** One tick of a live stand. */
export interface StandSetup {
  /** Every other knob the backend's tunables table names. */
  [key: string]: number | boolean;
  dome: number;
  copv_target: number;
  copv_fill_s: number;
  tank_fill_s: number;
  fuel_fill_s: number;
  /** The bottle arrives full and cold at the drawing's pressure, like a
   *  supplier's cylinder. Off (default), it starts empty and GN2 High Press
   *  fills it from GSE over copv_fill_s. */
  bottle_delivered: boolean;
  /** Multiplier on a vessel's gas-to-wall conductance while it is being
   *  charged: the jet stirs it and forced convection runs several times
   *  natural. 1 is a still vessel (adiabatic-charge heating in full). */
  fill_stirring: number;
  /** Ullage collapse: interfacial heat transfer gas -> liquid. */
  ullage_collapse: boolean;
  /** Propellant vapour in the ullage: boil-off and condensation. */
  ullage_vapour: boolean;
  /** Liquid-to-wall conductance [W/(m^2.K)]; what carries the ambient leak
   *  into the liquid. Zero disables chilldown. */
  chilldown: number;
  /** Heat the lines' own metal gives the gas. */
  line_walls: boolean;
  /** Air film on the outside of the tanks [W/(m^2.K)]; zero is a tank with
   *  no outside. In series with the insulation the drawing declares. */
  ambient_leak: number;
}

export interface SessionState {
  id: string;
  t: number;
  state: string;
  reachable: string[];
  converged: boolean;
  pressure_psi: Record<string, number>;
  node_psi: Record<string, number>;
  flow_kg_s: Record<string, number>;
  open: Record<string, boolean>;
  held: string[];
  tanks: TankState[];
  bottles: TankState[];
  setup: StandSetup;
  engine: EngineState | null;
  notes: string[];
  /** A run is being integrated ahead of the display; nothing advances yet. */
  computing: boolean;
  /** Why the stand stopped, if it has: a vessel over its MAWP. Only Reset
   *  clears it. */
  tripped?: string | null;
  /** Fraction of that run finished, 0..1. */
  progress: number;
  /** The display is serving a run computed ahead, at wall-clock pace. */
  replaying: boolean;
}

/** One burn from the COPV study, as the backend samples it. */
export interface StudyTrace {
  key: string;
  gas: string;
  label: string;
  litres: number;
  collapse: boolean;
  t: number[];
  ox_psi: number[];
  fuel_psi: number[];
  copv_psi: number[];
  chamber_psi: number[];
  thrust_n: number[];
  converged: boolean[];
  depleted_s: number | null;
  failed_ticks: number;
}

export interface StudySweepPoint {
  gas: string;
  litres: number;
  cubic_inches: number;
  floor_psi: number;
  burn_s: number | null;
  failed_ticks: number;
}

export interface StudyState {
  running: boolean;
  progress: number;
  stage: string;
  error: string;
  bottle_litres: number;
  bottle_cubic_inches: number;
  traces: StudyTrace[];
  sweep: StudySweepPoint[];
  notes: string[];
  gases: string[];
  bigger: boolean;
  collapse: boolean;
  vapour: boolean;
  chilldown: number;
  line_walls: boolean;
  swept: boolean;
}

export interface StudyOptions {
  gases: string[];
  bigger?: boolean;
  collapse?: boolean;
  sweep?: boolean;
  vapour?: boolean;
  /** Liquid-to-wall conductance [W/(m^2.K)]. Zero disables chilldown. */
  chilldown?: number;
  /** Heat the tube and its fittings give the gas passing through them. Needs
   * `wall_thickness` and `fitting_mass` on the drawing to do anything. */
  line_walls?: boolean;
}

/** Where the COPV study has got to, and its last result. */
export const getStudy = () => json<StudyState>('/api/study');

/** Start a run. Minutes, not seconds — poll `getStudy` for progress. */
export const startStudy = (options: StudyOptions) =>
  post<StudyState>('/api/study', options);

/** Stop at the next case boundary, keeping whatever finished. */
export const cancelStudy = () => post<StudyState>('/api/study/cancel', {});

export interface RunResult {
  /** The state machine state this was solved in. */
  state: string;
  diagram_id: string;
  engine_id: string;
  fluid_set: string;
  converged: boolean;
  message: string;
  elapsed_s: number;
  times_s: number[];
  channels: Channel[];
  frames: Frame[];
  controls: Record<string, number>;
  report: Report;
  balance: Balance | null;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    // The server explains itself in `detail`; showing "422" instead throws that
    // away and leaves the operator with nothing to act on.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* body was not JSON; the status line is all there is */
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export const listArtifacts = (kind?: 'diagram' | 'engine') =>
  json<Artifact[]>(`/api/library${kind ? `?kind=${kind}` : ''}`);

export function importFile(
  kind: 'diagram' | 'engine',
  file: File,
): Promise<ImportResult> {
  const body = new FormData();
  body.append('file', file);
  return json<ImportResult>(
    `/api/library/${kind === 'diagram' ? 'diagrams' : 'engines'}`,
    { method: 'POST', body },
  );
}

/** The design tools this instance can reach. */
export const listSources = () => json<Source[]>('/api/sources');

/** What the caller may import from one of them: theirs, shared, and browsable. */
export const listSourceDocuments = (key: string) =>
  json<SourceDocument[]>(`/api/sources/${key}/documents?with_releases=true`);

/** Pull one design into the library. `release` empty means the working copy. */
export const importFromSource = (
  key: string,
  doc: { doc_id: string; owner: string; release: string; name: string },
) =>
  json<ImportResult>(`/api/sources/${key}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });

export const removeArtifact = (id: string) =>
  json<{ removed: string }>(`/api/library/${id}`, { method: 'DELETE' });

export const getModel = (diagram: string, engine: string, fluidSet: string) =>
  json<ModelView>(
    `/api/model?diagram=${diagram}&engine=${engine}&fluid_set=${fluidSet}`,
  );

export interface Where {
  diagram: string;
  engine: string;
  fluidSet: string;
  machine: string;
}

const query = (w: Where) =>
  `diagram=${w.diagram}&engine=${w.engine}&fluid_set=${w.fluidSet}&machine=${w.machine}`;

const post = <T,>(url: string, body: unknown) =>
  json<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Start a stand: tanks empty, everything at atmosphere. */
export const openSession = (
  w: Where,
  body: { state: string } & Record<string, number | boolean | string>,
) => post<SessionState>(`/api/session?${query(w)}`, body);

/** Advance the stand. Driven by the client, so it stops when nobody watches. */
export const tickSession = (id: string, dt: number) =>
  post<SessionState>(`/api/session/${id}/tick`, { dt });

/** Change state, take a valve by hand, release one, turn the dome knob. */
export const commandSession = (
  id: string,
  body: {
    state?: string;
    valve?: string;
    open?: boolean;
    release?: string;
    setup?: Partial<StandSetup>;
  },
) => post<SessionState>(`/api/session/${id}/command`, body);

/** The trace so far, in the shape the plots already read. */
export const sessionHistory = (id: string, seconds = 300, maxPoints = 1500) =>
  json<RunResult>(`/api/session/${id}/history?seconds=${seconds}&max_points=${maxPoints}`);

/** Where a transducer's bar sits against its limits, keyed by tag. The DAQ
 *  reads these from its sensor config; a drawing does not carry them yet, so
 *  a high-pressure tag gets bottle limits and everything else tank limits.
 *  Wrong limits are worse than none, so both are stated. */
export function limitsFor(tag: string): { nop: number; meop: number } {
  const upper = tag.toUpperCase();
  if (upper.includes('HI') || upper.includes('HIGH')) return { nop: 4500, meop: 5000 };
  if (upper.includes('CHAMBER') || upper.includes('PC')) return { nop: 400, meop: 500 };
  return { nop: 550, meop: 700 };
}

/** One knob the twin assumes a value for: what it stands for, its unit,
 *  bounds, default, and whether a change applies live or on Reset. */
export interface Tunable {
  key: string;
  label: string;
  unit: string;
  group: string;
  explains: string;
  kind: 'number' | 'flag';
  low: number;
  high: number;
  step: number;
  applies: 'live' | 'reset';
  default: number | boolean;
}

export const getTunables = () => json<Tunable[]>('/api/tunables');

export const getStateMachine = (w: Where) =>
  json<StateMachine>(`/api/statemachine?${query(w)}`);

/**
 * Solve the stand as it stands, in one state. Behind every click: picking a
 * state, taking a valve by hand. One steady solve, so it answers fast enough
 * to feel like the stand rather than like a report.
 */
export const goToState = (
  w: Where,
  body: {
    state: string;
    /** Where the stand is now, so the server can refuse an illegal move. */
    from: string;
    forced: Record<string, number>;
    dome: number;
  },
) => post<RunResult>(`/api/state?${query(w)}`, body);

/** Run a burn: hold the pre-fire state, transition, sample. */
export const fireStand = (
  w: Where,
  body: {
    state: string;
    prefire: string;
    duration: number;
    lead_in: number;
    sample_hz: number;
    dome: number;
    forced: Record<string, number>;
  },
) => post<RunResult>(`/api/fire?${query(w)}`, body);

/**
 * Channel colours, lifted from the DAQ's `lib/sensor-colors.ts` so the same
 * measurement is the same colour in both tools.
 */
export const CHANNEL_COLORS: Record<string, string> = {
  'PT-GN2-HI': '#ADFF2F',
  'PT-GN2-REG': '#228B22',
  'PT-OX-UP': '#38BDF8',
  'PT-OX-DN': '#4169E1',
  'PT-FU-UP': '#FF4500',
  'PT-FU-DN': '#CC0000',
};

export const channelColor = (tag: string) => CHANNEL_COLORS[tag] ?? '#3498DB';

export const fixed = (value: number, places = 1) => {
  // A vented gauge reads 0, never "-0.0": the model's rounding noise around
  // atmosphere is not a reading.
  const shown = Math.abs(value) < 0.5 * 10 ** -places ? 0 : value;
  return shown.toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
};

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * When an artifact was imported, short enough to sit in a list.
 *
 * The list needs this more than it needs the byte count. Six drawings can share
 * a name — the stand gets re-exported, and content addressing correctly makes
 * each export its own artifact — and then the only question a person actually
 * has is "which of these is the one I saved last". A size in kB does not answer
 * it; a date does.
 */
export const when = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = (Date.now() - t) / 86400000;
  if (days < 1) return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return `${Math.floor(days)}d ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

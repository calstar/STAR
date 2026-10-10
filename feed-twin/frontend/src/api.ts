/**
 * The API client. Every quantity arrives in a named unit; nothing here converts.
 *
 * Artifacts are addressed by the hash of their own bytes, so an id names one
 * specific drawing or engine config forever — which is what makes a result
 * reproducible a year later.
 */
import type { Edge, Node } from '@xyflow/react';

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
  /** An engine's EngineDesign card, as it describes itself; empty when the
   *  engine fires feedtwin's simplified model. */
  card?: EngineCardInfo | Record<string, never>;
}

export interface EngineCardInfo {
  card_config_sha256: string;
  card_center_psia: number;
  card_ambient_pa: number;
  card_within_tolerance: boolean;
  /** Worst relative error against held-out EngineDesign solves. */
  card_error: number;
  /** Unix seconds. */
  card_built: number;
}

export const hasCard = (a: Artifact) => Boolean(a.card && 'card_built' in a.card);

export interface ImportResult {
  artifact: Artifact;
  already_present: boolean;
  /** Why an engine came in without EngineDesign's card, when it did. */
  card_error?: string;
}

export interface Freshness {
  artifact_id: string;
  tracked: boolean;
  /** null when the design tool could not be asked. */
  current: boolean | null;
  detail: string;
}

/** One burn, totalled from the stand's history the way Layer X totals one.
 *  Pressures are gauge, like the rest of the console. */
export interface BurnTank {
  id: string;
  label: string;
  side: string;
  start_psi: number;
  min_psi: number;
  start_kg: number;
  end_kg: number;
}

export interface Burn {
  start_s: number;
  end_s: number;
  duration_s: number;
  burning: boolean;
  impulse_Ns: number;
  thrust_mean_N: number;
  thrust_peak_N: number;
  thrust_min_N: number;
  pc_mean_psi: number;
  pc_min_psi: number;
  pc_max_psi: number;
  of_mean: number;
  of_min: number;
  of_max: number;
  isp_s: number;
  cstar_mps: number;
  oxidiser_kg: number;
  fuel_kg: number;
  stiffness_oxidiser_min: number;
  stiffness_fuel_min: number;
  extrapolated_steps: number;
  steps: number;
  tanks: BurnTank[];
  engine_model: string;
  /** The run this burn was recorded as, once it ended. */
  run_id?: string;
  /** The recorded traces, from ignition: they outlive the session's history. */
  series?: BurnSeries | null;
}

export interface BurnSeries {
  t: number[];
  thrust_N: number[];
  pc_psig: number[];
  of: number[];
  tanks: Record<string, number[]>;
  labels: Record<string, string>;
}

/** A tank's trace colour, by what it holds. */
export const tankColor = (label: string) =>
  /lox|ox/i.test(label) ? '#38BDF8' : /fu|eth|fuel/i.test(label) ? '#FF4500' : '#ADFF2F';

export interface Burns {
  engine_id: string;
  engine_model: string;
  burns: Burn[];
}

export interface Actuator {
  id: string;
  tag: string;
  signal: string;
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
  /** Operator overrides that took effect on this assembly. */
  overrides?: Assumption[];
  overrides_hash?: string;
}

export interface ModelView {
  diagram_id: string;
  engine_id: string;
  title: string;
  actuators: Actuator[];
  report: Report;
  engine: Record<string, unknown>;
  /** Which sheet of the drawing each node is on, by node id. Absent from an
   *  older server. */
  pages?: Record<string, string>;
  /** What the team has hidden from the console, by node id. Shared, not per
   *  browser. Absent from an older server. */
  console_hidden?: string[];
  /** The order the console draws transducers and tanks in. Shared, like
   *  `console_hidden`. */
  console_order?: { pts?: string[]; tanks?: string[] };
  /** Drawing ids off the vehicle: the cart. The console starts them hidden. */
  ground?: string[];
  /** The cart's K-bottles and dewars, which the console does not show. */
  ground_bottles?: string[];
  /** Built with the drawn GSE ignored: the vessels the cut left out. */
  ground_cut?: string[];
  /** Where each knob starts on this drawing [psig], by knob id: the
   *  regulators' drawn settings, what a knob's default goes back to. */
  drawn_knobs?: Record<string, number>;
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
  /** What each instrument's node is at [K], by instrument id. */
  temperature_K?: Record<string, number>;
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
  /** Amber and red lines [psig] from what the transducer reads (the drawn
   *  operating pressure and MAWP of its vessel, the engine's design Pc).
   *  Absent: none drawn for what it reads; the bar has no lines. */
  nop?: number | null;
  meop?: number | null;
  /** Where they came from, for a hover. */
  limits?: string;
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
  /** State -> [row, col] on the panel (the DAQ's panel_row/col). */
  layout?: Record<string, [number, number]>;
  /** The abort states: always reachable. */
  aborts?: string[];
  /** The tables as the editor holds them. */
  table?: MachineDef;
  /** The stand's own table, not the shipped DAQ one. */
  edited?: boolean;
  /** Rows the twin reads by name (see `Hookup.builtin`). */
  builtin?: Record<string, string>;
}

/** A state as the State machine tab edits it: its place on the panel and
 *  whether it is an abort (always reachable). */
export interface MachineStateDef {
  name: string;
  row: number | null;
  col: number | null;
  abort: boolean;
}

/** The DAQ's tables, as the twin edits them (feedtwin
 *  `StateMachine.to_dict`). `open[state]` are the rows OPEN in it, as
 *  written; `allowed[state]` the states it may go to (absent: the state has
 *  no row in the transition table, and goes nowhere). */
export interface MachineDef {
  schema?: number;
  name?: string;
  states: MachineStateDef[];
  actuators: string[];
  open: Record<string, string[]>;
  allowed: Record<string, string[]>;
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
  /** What a load fills this tank to [kg]: the fire load, else the full fraction. */
  load_kg?: number;
  /** The engine's fire load for this tank [kg]; absent when it names none. */
  fire_load_kg?: number | null;
  /** A LOX load still chilling the wall: nothing collects yet. */
  chilling?: boolean;
  /** What the load is delivering into the tank [g/s]. */
  fill_flow_g_s?: number;
  /** Where the regulator feeding this tank locks up now [psig]: dome + bias
   *  less the supply effect of the bottle behind it. Absent: no regulator. */
  lockup_psi?: number | null;
  /** [charged, empty]: where it locks up with the COPV at its fill setting and
   *  with it empty [psig] -- the range over a burn. */
  lockup_range_psi?: [number, number] | null;
  /** The drawn MAWP [psig]; the stand trips above it. */
  mawp_psi?: number | null;
  /** What the drawing says the vessel holds [L]. */
  volume_L?: number;
  /** Which leg the tank is on, from what it holds. Empty on a bottle. */
  side?: 'lox' | 'fuel' | '';
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
  /** LOX dewar pressure [psig]; 0 loads at the fixed rate of tank_fill_s. */
  dewar_psi: number;
  /** Cv of the fill line's valves: in practice how far the dewar valve is open. */
  dewar_fill_cv: number;
  /** The bottle arrives full and cold at the drawing's pressure, like a
   *  supplier's cylinder. Off (default), it starts empty and GN2 High Press
   *  fills it from GSE over copv_fill_s. */
  bottle_delivered: boolean;
  /** The cart drawn on the GSE page is not simulated: the rocket alone, filled
   *  by the built-in charge and loads at these settings. Changing it opens a
   *  fresh stand. */
  ignore_gse: boolean;
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
  /** What each instrument's node is at [K], by instrument id. */
  temperature_K?: Record<string, number>;
  node_psi: Record<string, number>;
  flow_kg_s: Record<string, number>;
  open: Record<string, boolean>;
  held: string[];
  tanks: TankState[];
  bottles: TankState[];
  setup: StandSetup;
  engine: EngineState | null;
  notes: string[];
  /** The GSE page's knobs, from the drawing's hookup. */
  knobs?: LiveKnob[];
  /** The hookup's console names, by drawing (channel) id: a connector's
   *  name for what is on the DAQ box, the alias for anything else. */
  aliases?: Record<string, string>;
  /** What the DAQ box sees, by drawing id: every symbol on a connector and
   *  every valve a state-table row drives. Absent/null on a hookup that is
   *  not wired yet: everything is, as before the box. */
  wired?: string[] | null;
  /** Why the stand stopped, if it has: a vessel over its MAWP. Only Reset
   *  clears it. */
  tripped?: string | null;
  /** Hash of the operator overrides this stand was built with. */
  overrides_hash?: string;
}

/** One study case as the view writes it: the stand, with these changes.
 *  Anything left out is the stand's own. */
export interface StudyCaseIn {
  label: string;
  /** Bottle at T-0 [psig]; also the charge the regulators are set against. */
  copv_psi?: number | null;
  /** Knob id -> setting [psig]. */
  knobs?: Record<string, number>;
  bottle_litres?: number | null;
  /** Liquid over tank volume at T-0, 0..1. */
  fill_fraction?: number | null;
  pressurant?: 'helium' | 'nitrogen' | null;
  /** Configuration rows, by key. */
  setup?: Record<string, number | boolean>;
  /** The swept quantity's value for this case. */
  x?: number | null;
}

/** One finished case. Pressures are gauge; `t` is from Fire. */
export interface StudyCaseOut {
  label: string;
  x: number | null;
  changes: string[];
  t0: {
    copv_psi?: number;
    tank_psi?: number;
    lockup_psi?: Record<string, number>;
    fill_fraction?: number;
    bottle_litres?: number | null;
  };
  t: number[];
  tanks: Record<string, number[]>;
  bottles: Record<string, number[]>;
  chamber_psi: number[];
  thrust_n: number[];
  converged: boolean[];
  /** The burn totalled as the Engine tab totals one. */
  outcome: Partial<Burn>;
  depleted_s: number | null;
  tripped: string;
  failed_ticks: number;
  notes: string[];
  error: string;
}

export interface StudyState {
  running: boolean;
  progress: number;
  stage: string;
  error: string;
  /** What it ran on: the stand's name, or the drawing's. */
  stand: string;
  engine_name: string;
  /** What the cases' x is, when they are a sweep. */
  sweep: string;
  horizon_s: number;
  planned: number;
  cases: StudyCaseOut[];
  notes: string[];
}

export interface StudyRequestIn {
  /** The cockpit session whose stand every case starts from. */
  session: string;
  cases: StudyCaseIn[];
  horizon_s: number;
  sweep?: string;
}

/** Where the study has got to, and the cases it has finished. */
export const getStudy = () => json<StudyState>('/api/study');

/** Start a run on the open stand. Poll `getStudy` for progress. */
export const startStudy = (request: StudyRequestIn) => post<StudyState>('/api/study', request);

/** Stop after the case running now, keeping the ones finished. */
export const cancelStudy = () => post<StudyState>('/api/study/cancel', {});

/** A session's trace, in the shape the plots read. */
export interface RunResult {
  message: string;
  times_s: number[];
  channels: Channel[];
  /** Every state change in the window: rules across the plots. */
  events?: { t: number; label: string }[];
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

/** (Re)build an engine's EngineDesign card. Takes EngineDesign 5-15 s. */
export const buildCard = (id: string) =>
  json<ImportResult>(`/api/library/${id}/card`, { method: 'POST' });

/** Is a pulled artifact still what its design tool holds? */
export const getFreshness = (id: string) =>
  json<Freshness>(`/api/library/${id}/freshness`);

/** Pull the design tool's working copy again, as a new artifact. */
export const refreshArtifact = (id: string) =>
  json<ImportResult>(`/api/library/${id}/refresh`, { method: 'POST' });

export const removeArtifact = (id: string) =>
  json<{ removed: string }>(`/api/library/${id}`, { method: 'DELETE' });

export const getModel = (diagram: string, engine: string, fluidSet: string, ignoreGse = false) =>
  json<ModelView>(
    `/api/model?diagram=${diagram}&engine=${engine}&fluid_set=${fluidSet}&ignore_gse=${ignoreGse}`,
  );

/** The drawing as pid-designer saved it, for pid-designer's own canvas to draw. */
export interface Drawing {
  nodes: Node[];
  edges: Edge[];
}

export const getDrawing = (diagram: string) =>
  json<Drawing>(`/api/diagram?diagram=${diagram}`);

// ------------------------------------------------------------------ drawing

export interface ParamValue {
  value: number;
  unit: string;
  source: string;
  reference: string;
}

export interface OverrideValue extends ParamValue {
  by: string;
  at: string;
  /** What the drawing said when the override was made. */
  was: ParamValue | null;
}

/** One number on one symbol: as drawn, as filled in, as typed over. */
export interface DrawingParam {
  name: string;
  drawing: ParamValue | null;
  assumed: ParamValue | null;
  override: OverrideValue | null;
  effective: ParamValue | null;
  /** The drawing changed this value after the override was made. */
  stale: boolean;
  /** Why it cannot be overridden, if it cannot. */
  locked: string;
  units: string[];
}

export interface DrawingElement {
  id: string;
  kind: 'symbol' | 'line';
  tag: string;
  type: string;
  role: string;
  fluid: string;
  params: DrawingParam[];
  options: Record<string, string>;
  segments: number;
  on_console: boolean;
  console_hidden: boolean;
  hidden_by: string;
}

export interface DrawingData {
  diagram_id: string;
  /** The drawing's name — what overrides are kept under across re-imports. */
  key: string;
  source: string;
  imported_at: string;
  elements: DrawingElement[];
  orphaned: string[];
  overrides_hash: string;
  override_sources: string[];
}

/** What feed-twin read from the drawing, for the P&ID tab's panel. Not the
 *  drawing itself -- that is `getDrawing`. */
export const getDrawingData = (diagram: string, engine: string, fluidSet = 'hotfire') =>
  json<DrawingData>(
    `/api/drawing?diagram=${diagram}&engine=${engine}&fluid_set=${fluidSet}`,
  );

export const setOverride = (body: {
  diagram: string;
  element: string;
  parameter: string;
  value: number;
  unit: string;
  source: string;
  reference: string;
}) =>
  json<unknown>('/api/drawing/override', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const clearOverride = (diagram: string, element: string, parameter: string) =>
  json<unknown>(
    `/api/drawing/override?${new URLSearchParams({ diagram, element, parameter })}`,
    { method: 'DELETE' },
  );

export interface ConsoleShared {
  hidden: string[];
  order?: { pts?: string[]; tanks?: string[] };
}

export const getConsoleHidden = (diagram: string) =>
  json<ConsoleShared>(`/api/drawing/console?diagram=${diagram}`);

/** The order the console draws transducers and tanks in, for everyone. */
export const setConsoleOrder = (diagram: string, order: { pts: string[]; tanks: string[] }) =>
  json<ConsoleShared>('/api/drawing/console/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diagram, order }),
  });

/** Make the console exactly what a saved stand had. */
export const setConsoleView = (diagram: string, hidden: string[], order: { pts: string[]; tanks: string[] }) =>
  json<ConsoleShared>('/api/drawing/console/view', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diagram, hidden, order }),
  });

export const setConsoleHidden = (diagram: string, element: string, hidden: boolean) =>
  json<{ hidden: string[] }>('/api/drawing/console', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diagram, element, hidden }),
  });

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
  body: { state: string } & Record<string, unknown>,
) => post<SessionState>(`/api/session?${query(w)}`, body);

/** Skip the pad: tanks loaded, bottle charged, every tank at its regulator's
 *  lockup at the knobs as set, in Ready. */
export const sessionT0 = (id: string) => post<SessionState>(`/api/session/${id}/t0`, {});

/** Advance the stand. Driven by the client, so it stops when nobody watches. */
export const tickSession = (id: string, dt: number) =>
  post<SessionState>(`/api/session/${id}/tick`, { dt });

/** Change state, take a valve by hand, release one, turn the dome knob, or skip
 *  a load's chilldown (`skip_chill`: true for every tank, or one tank's id). */
export const commandSession = (
  id: string,
  body: {
    state?: string;
    valve?: string;
    open?: boolean;
    release?: string;
    setup?: Partial<StandSetup>;
    knob?: { id: string; value: number };
    skip_chill?: true | string;
    /** Rename what the console shows, live (the hookup's aliases). */
    aliases?: Record<string, string>;
    /** Rename aliases and connectors live; refused (409) when that would
     *  change what a table row drives. */
    names?: { aliases: Record<string, string>; channels: ChannelDef[] | null };
  },
) => post<SessionState>(`/api/session/${id}/command`, body);

/** A dial on the GSE page and the regulators (drawing ids) it sets [psig]. */
export interface KnobDef {
  id: string;
  label: string;
  regulators: string[];
  psig: number;
  low: number;
  high: number;
}

/** A board in the DAQ box. */
export type BoardId = 'sol12' | 'sol24' | 'pt_low' | 'pt_high' | 'rtd' | 'tc';
export type SymbolKind = 'valve' | 'pt' | 'rtd' | 'tc';

export interface BoardDef {
  id: BoardId;
  label: string;
  /** What plugs into it. */
  kind: SymbolKind;
}

/** One connector on the DAQ box: board, connector number (from 1), the name
 *  the DAQ gives it (console name; for a valve, the state table's row), and
 *  the drawing id its cable goes to. */
export interface ChannelDef {
  board: BoardId;
  slot: number;
  name: string;
  symbol: string;
}

/** A symbol a connector can take. */
export interface HookupSymbol {
  id: string;
  label: string;
  type: string;
  page: string;
  kind: SymbolKind;
  /** The board it goes on unless somebody says otherwise. */
  board: BoardId;
  /** On the cart, not the vehicle. */
  ground: boolean;
}

/** What a person decided about a drawing's controls: the DAQ box
 *  (`channels`), the stand's own state table (`machine`, null = the DAQ's),
 *  the knobs. `valves` are pins from before the box ("" = no valve here). */
export interface HookupBody {
  valves: Record<string, string>;
  knobs: KnobDef[];
  /** What the console calls a symbol that is not on the box, by drawing
   *  (channel) id: a tank, the engine's channels. */
  aliases?: Record<string, string>;
  /** Always a list from the API: the box the twin's matching amounts to when
   *  nobody has wired it (`Hookup.wired` false). */
  channels?: ChannelDef[] | null;
  /** Rows of five connectors each board shows. */
  rows?: Partial<Record<BoardId, number>>;
  machine?: MachineDef | null;
}

export interface Hookup {
  lineage: string;
  saved: boolean;
  hookup: HookupBody;
  suggested: HookupBody;
  actuators: string[];
  valves: { id: string; label: string; page: string; role: string[] }[];
  regulators: { id: string; label: string; kind: 'loader' | 'dome' | 'plain'; page: string; drawn_psig: number | null }[];
  bound: Record<string, string>;
  unmatched: string[];
  uncommanded: string[];
  by_role: string[];
  by_user: string[];
  pages: string[];
  mated: string[][];
  /** `bound` and the rest are the rocket-only stand's wiring. */
  vehicle_only?: boolean;
  /** The box was written down (saved, or the stand's). False: `hookup`'s
   *  channels are the twin's suggestion. */
  wired: boolean;
  boards: BoardDef[];
  symbols: HookupSymbol[];
  /** The DAQ's table as shipped. */
  machine_shipped: MachineDef;
  /** What is wrong with the table this hookup runs. */
  machine_warnings: string[];
  /** Rows the twin reads by name, and what each does with no valve wired to
   *  it (the built-in COPV charge and dump, the transfer tank's press). */
  builtin?: Record<string, string>;
  /** What this drawing cannot have: a cable to a symbol it lost, a knob on a
   *  regulator it lacks. A save is refused until they are unplugged. */
  problems?: string[];
}

/** The id of the knob the session's dome setting drives. */
export const DOME_KNOB = 'dome';
/** The knob that sets the COPV charge (Setup copv_target): the drawn fill
 *  regulator when the cart is on the drawing, the built-in charge when not. */
export const CHARGE_KNOB = 'charge';

export interface LiveKnob {
  id: string;
  label: string;
  psig: number;
  low: number;
  high: number;
  /** Labels of the regulators it sets. */
  regulators: string[];
}

/** ``ignoreGse``: wired as a rocket-only stand runs it (the hookup itself is
 *  still the whole drawing's). */
const whereQuery = (w: { diagram: string; engine: string; fluidSet: string; machine: string; ignoreGse?: boolean }) =>
  `diagram=${w.diagram}&engine=${w.engine}&fluid_set=${w.fluidSet}&machine=${w.machine}` +
  (w.ignoreGse ? '&ignore_gse=true' : '');

export const getHookup = (w: { diagram: string; engine: string; fluidSet: string; machine: string; ignoreGse?: boolean }) =>
  json<Hookup>(`/api/hookup?${whereQuery(w)}`);

export const saveHookup = (w: { diagram: string; engine: string; fluidSet: string; machine: string; ignoreGse?: boolean }, body: HookupBody) =>
  json<Hookup>(`/api/hookup?${whereQuery(w)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const resetHookup = (w: { diagram: string; engine: string; fluidSet: string; machine: string; ignoreGse?: boolean }) =>
  json<Hookup>(`/api/hookup?${whereQuery(w)}`, { method: 'DELETE' });

/** A stand's own hookup, shown and bound as the drawing's would be. Saves
 *  nothing; refuses what a save would, unless `check` is false (only
 *  showing it, with what is wrong in `problems`). */
export const viewHookup = (
  w: { diagram: string; engine: string; fluidSet: string; machine: string; ignoreGse?: boolean },
  body: HookupBody,
  check = true,
) =>
  json<Hookup>(`/api/hookup/view?${whereQuery(w)}${check ? '' : '&check=false'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** What the twin would say about a table being edited. */
export const checkMachine = (table: MachineDef) =>
  json<{ ok: boolean; error: string; warnings: string[] }>('/api/statemachine/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(table),
  });

/** The solver tab: per tick, as columns (feedtwin.session.diagnostics). */
export interface SolverTrace {
  t: number[];
  couplings: number[];
  iterations: number[];
  iterations_max: number[];
  residual: number[];
  continuity: number[];
  converged: boolean[];
  chamber_residual_psi: number[];
  inventory_kg: number[];
  mass_error_kg: number[];
  guard_kg: number[];
  guard_J: number[];
  /** Cumulative mass across the boundary, in plus out [kg]. */
  crossed_kg?: number[];
  summary: Record<string, number>;
}

export const sessionSolver = (id: string, seconds = 300, maxPoints = 600) =>
  json<SolverTrace>(`/api/session/${id}/solver?seconds=${seconds}&max_points=${maxPoints}`);

/** Every burn still in the stand's history, oldest first. */
export const sessionBurns = (id: string) => json<Burns>(`/api/session/${id}/burns`);

/** The trace so far, in the shape the plots already read. */
export const sessionHistory = (id: string, seconds = 300, maxPoints = 1500) =>
  json<RunResult>(`/api/session/${id}/history?seconds=${seconds}&max_points=${maxPoints}`);

/** A channel's amber and red lines: the drawing's, where the backend found
 *  them (the vessel the transducer reads: its drawn operating pressure and
 *  MAWP; the engine's design Pc). None where it found none -- a transducer on a
 *  dome line or a manifold reads no vessel. The DAQ reads these from its
 *  sensor config; they used to be guessed here from the tag (550/700 on a
 *  dome PT, 4,500/5,000 on anything named HI), and a wrong line is worse than
 *  none. */
export function limitsOf(c: Pick<Channel, 'nop' | 'meop'>): { nop?: number; meop?: number } {
  return { nop: c.nop ?? undefined, meop: c.meop ?? undefined };
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

export const getStateMachine = (w: Where, ignoreGse = false) =>
  json<StateMachine>(`/api/statemachine?${query(w)}&ignore_gse=${ignoreGse}`);

/** The table a running stand commands, and how it is bound: a stand's own
 *  hookup included. */
export const sessionStateMachine = (id: string) => json<StateMachine>(`/api/session/${id}/statemachine`);

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
  // The engine, in the console's own engine colours.
  PC: '#F39C12',
  Thrust: '#e2e2e2',
  'O/F': '#9B59B6',
  'LOX flow': '#38BDF8',
  'Fuel flow': '#FF4500',
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

// ---------------------------------------------------------------------- runs

/** The stand document a run was fired on. */
export interface RunStand {
  id: string;
  owner: string;
  name: string;
  updatedAt: string;
  release: string;
}

export interface CodeVersion {
  app: string;
  library: string;
  commit: string;
  dirty: boolean;
}

/** One burn, as listed: outcome numbers and whether the solver kept up. */
export interface RunSummary {
  id: string;
  owner: string;
  user: string;
  created: string;
  label: string;
  stand: RunStand | null;
  engine_model: string;
  /** What it ran on: library ids, and whether the GSE was cut away. */
  diagram?: string;
  engine?: string;
  rocket_only?: boolean;
  outcome: Record<string, number | null>;
  converged: boolean;
  mass_error_ppm: number | null;
  code: CodeVersion | null;
}

export interface RunRecord extends RunSummary {
  inputs: Record<string, unknown>;
  solver: Record<string, number>;
  series: {
    t: number[];
    thrust_N: number[];
    pc_psig: number[];
    of: number[];
    tanks: Record<string, number[]>;
    labels: Record<string, string>;
  };
  clock: { start_s: number; end_s: number };
  notes: string[];
}

export interface OutcomeDelta {
  key: string;
  label: string;
  unit: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  pct: number | null;
}

export interface RunDiff {
  a: RunSummary;
  b: RunSummary;
  inputs: { key: string; group: string; a: unknown; b: unknown }[];
  groups: string[];
  code: { key: string; a: unknown; b: unknown }[];
  outcome: OutcomeDelta[];
}

export interface Attribution {
  key: string;
  label: string;
  unit: string;
  a: number;
  b: number;
  total: number;
  parts: { label: string; delta: number }[];
  interaction: number;
}

export interface Rung {
  label: string;
  swapped: string[];
  outcome: Record<string, number>;
  notes: string[];
  error: string;
  wall_s: number;
}

export interface ExplainState {
  running: boolean;
  a?: string;
  b?: string;
  stage?: string;
  done?: number;
  total?: number;
  rungs?: Rung[];
  base?: Rung;
  full?: Rung;
  error?: string;
  attribution?: Attribution[];
  reproduction?: { run: string; key: string; recorded: number; replayed: number }[];
}

const ownerQ = (owner?: string | null) => (owner ? `owner=${encodeURIComponent(owner)}` : '');

export const listRuns = (stand?: { id: string; owner?: string | null } | null) => {
  const q = stand
    ? `?stand=${encodeURIComponent(stand.id)}${stand.owner ? `&${ownerQ(stand.owner)}` : ''}`
    : '';
  return json<RunSummary[]>(`/api/twin/runs${q}`);
};
export const getRun = (id: string, owner?: string | null) =>
  json<RunRecord>(`/api/twin/runs/${encodeURIComponent(id)}${owner ? `?${ownerQ(owner)}` : ''}`);
export const diffRuns = (a: RunSummary, b: RunSummary) =>
  json<RunDiff>(
    `/api/twin/runs/diff?a=${a.id}&b=${b.id}&owner_a=${encodeURIComponent(a.owner)}&owner_b=${encodeURIComponent(b.owner)}`,
  );
export const explainRuns = (a: RunSummary, b: RunSummary) =>
  post<ExplainState>('/api/twin/runs/explain', { a: a.id, b: b.id, owner_a: a.owner, owner_b: b.owner });
export const explainStatus = () => json<ExplainState>('/api/twin/runs/explain');
export const explainCancel = () => post<ExplainState>('/api/twin/runs/explain/cancel', {});

/** What the model has been checked against (backend/version.py VALIDATION). */
export interface Validation {
  status: 'unvalidated' | 'calibrated' | 'validated';
  label: string;
  checked: string[];
  not_checked: string[];
}

export const getVersion = () =>
  json<CodeVersion & { validation: Validation }>('/api/version');

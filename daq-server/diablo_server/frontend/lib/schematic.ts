/**
 * The Schematic page's model: the stand's P&ID as feed-twin exported it
 * (`config/stand_pid.json`), and what to paint on it from a frame of live
 * values.
 *
 * The page is read-only and never touched: the whole stand, fitted to the
 * screen. Each symbol with a cable on the DAQ box carries its live value;
 * everything else is dimmed, so the eye goes to what the DAQ can see.
 *
 * The join between the DAQ and the drawing is the connector's `name`: it is
 * the DAQ's role name (`[actuator_roles]`, `[sensor_roles_*]`), the same name
 * every other page reads a value by. Nothing here matches tags to names.
 *
 * The overlay is a function of a *frame* -- connector name to value -- not of
 * the store, so a recording can drive it as well as the live stream.
 *
 * Pressures are gauge, as the DAQ logs them; readings show the number alone
 * and the page footer says "psig".
 * Where the drawing and the DAQ config disagree (NO/NC, names), the DAQ is
 * believed -- it is what the boards are told -- and the page says so.
 *
 * The bundle's shape is feed-twin's (`feed-twin/frontend/src/lib/daqBundle.ts`);
 * this is the DAQ's copy of it, checked by `FORMAT`.
 */

export const FORMAT = 'star.stand-pid/1';

// ── The bundle ───────────────────────────────────────────────────────────────

export type BoardId = 'sol12' | 'sol24' | 'pt_low' | 'pt_high' | 'rtd' | 'tc' | string;

export interface BundleChannel {
  board: BoardId;
  slot: number;
  /** The DAQ's role name: "LOX Main", "Ox Upstream". */
  name: string;
  /** The drawing symbol its cable goes to. */
  symbol: string;
}

export interface BundleSymbol {
  type: string;
  tag: string;
  page: string;
  /** What the *drawing* says; the DAQ's config is believed over it. */
  normally: 'NO' | 'NC' | null;
}

export interface SectionLimit {
  psig: number;
  vessel: string;
  basis: 'MAWP' | 'burst';
  burst_psig?: number;
  factor?: number;
}

export interface BundleSection {
  lines: string[];
  limit: SectionLimit | null;
}

/** Where a drawn limit comes from, in the page's words: "LOX-Tank burst 1500 psig / 2". */
export function limitSource(l: SectionLimit): string {
  return l.basis === 'MAWP' ? `${l.vessel} MAWP` : `${l.vessel} burst ${Math.round(l.burst_psig ?? 0)} psig / ${l.factor ?? '?'}`;
}

export type Box = [number, number, number, number];

export interface StandPid {
  format: string;
  drawing: { diagram: string; artifact: string | null; sha256: string; exported_at: string };
  svg: string;
  width: number;
  height: number;
  boxes: Record<string, Box>;
  mates: Record<string, string>;
  symbols: Record<string, BundleSymbol>;
  channels: BundleChannel[];
  sections?: Record<string, BundleSection>;
  sectionOf?: Record<string, string>;
}

/** The bundle, or what is wrong with it, said so a person can fix it. */
export function parseStandPid(raw: unknown): { pid: StandPid } | { error: string } {
  const b = raw as Partial<StandPid> | null;
  if (!b || typeof b !== 'object') return { error: 'stand_pid.json is not an object.' };
  if (b.format !== FORMAT) {
    return {
      error: `stand_pid.json is format "${String(b.format)}"; this page reads "${FORMAT}". Export it again from feed-twin.`,
    };
  }
  if (typeof b.svg !== 'string' || !b.svg.startsWith('<svg')) return { error: 'stand_pid.json carries no drawing.' };
  if (!Array.isArray(b.channels) || !b.symbols || !b.boxes) return { error: 'stand_pid.json is missing its channels.' };
  return { pid: b as StandPid };
}

// ── The DAQ's names, from its running config ─────────────────────────────────

export type Kind = 'valve' | 'pressure' | 'temperature';

export interface DaqName {
  name: string;
  kind: Kind;
  boardId: number | null;
  /** Actuators: unpowered position, from [actuator_roles]. */
  normally?: 'NO' | 'NC';
  ballValve?: boolean;
  /** Transducers: full scale, psig ([calibration_full_scale_<board>], else the board's default). */
  fullScalePsi?: number;
}

/** Ratiometric PTs read 1000 psi full scale unless the config says otherwise (config_base.toml). */
export const DEFAULT_PT_FULL_SCALE_PSI = 1000;

const fold = (s: string) => s.trim().toLowerCase();

/**
 * Every name the running config gives a valve or transducer, keyed by name
 * ignoring case (the hookup's names are unique ignoring case).
 */
export function daqNamesOf(config: any): Map<string, DaqName> {
  const out = new Map<string, DaqName>();
  const boards: Record<string, any> = config?.boards ?? {};
  const typeOfId = new Map<number, string>();
  for (const b of Object.values(boards)) if (typeof b?.board_id === 'number') typeOfId.set(b.board_id, String(b.type ?? ''));

  for (const [name, v] of Object.entries<any>(config?.actuator_roles ?? {})) {
    const arr = Array.isArray(v) ? v : [];
    const boardId = typeof arr[2] === 'number' ? arr[2] : null;
    out.set(fold(name), {
      name,
      kind: 'valve',
      boardId,
      normally: String(arr[0] ?? 'NC').toUpperCase() === 'NO' ? 'NO' : 'NC',
      ballValve: boardId != null && typeOfId.get(boardId) === 'BALL_VALVE',
    });
  }

  for (const [section, roles] of Object.entries<any>(config ?? {})) {
    const m = /^sensor_roles_(.+)$/.exec(section);
    if (!m || !roles || typeof roles !== 'object') continue;
    const board = boards[m[1]] ?? {};
    const type = String(board.type ?? '').toUpperCase();
    const kind: Kind | null = type === 'PT' ? 'pressure' : type === 'RTD' || type === 'TC' ? 'temperature' : null;
    if (!kind) continue;
    const scales = config?.[`calibration_full_scale_${m[1]}`] ?? {};
    for (const name of Object.keys(roles)) {
      const own = Number(scales[name]);
      out.set(fold(name), {
        name,
        kind,
        boardId: typeof board.board_id === 'number' ? board.board_id : null,
        ...(kind === 'pressure'
          ? { fullScalePsi: own > 0 ? own : Number(board.hp_pt_full_scale_psi) > 0 ? Number(board.hp_pt_full_scale_psi) : DEFAULT_PT_FULL_SCALE_PSI }
          : {}),
      });
    }
  }
  return out;
}

// ── What a symbol is, for the overlay ────────────────────────────────────────

const PRESSURE_TYPES = new Set(['PT']);
const TEMPERATURE_TYPES = new Set(['RTD', 'TC']);
const VALVE_TYPES = new Set(['SOL', 'ROT', 'MOV']);

export function kindOf(symbolType: string): Kind | null {
  if (PRESSURE_TYPES.has(symbolType)) return 'pressure';
  if (TEMPERATURE_TYPES.has(symbolType)) return 'temperature';
  if (VALVE_TYPES.has(symbolType)) return 'valve';
  return null;
}

/** A connector name as the store keys it: "Ox Upstream" -> "Ox_Upstream". */
export const entityName = (name: string) => name.trim().replace(/\s+/g, '_');

/** The store key a transducer's calibrated pressure is read from. */
export const pressureEntity = (name: string) => `PT_Cal.${entityName(name)}`;

/** The store key an RTD's or thermocouple's calibrated temperature is read from. */
export const temperatureEntity = (name: string, symbolType: string) =>
  `${symbolType === 'TC' ? 'TC' : 'RTD'}_Cal.${entityName(name)}`;

// ── The frame ────────────────────────────────────────────────────────────────

/** One stream's last value and how old it is; stale when ageMs > staleAfterMs. */
export interface Sample {
  value: number | null;
  ageMs: number | null;
  staleAfterMs: number;
}

export interface ValveSample {
  /** Commanded position, already NO/NC-resolved by the sequencer: true is open. */
  open: boolean | null;
  ageMs: number | null;
  staleAfterMs: number;
  /** Coil current (actuator boards) or position (ball valves). */
  currentA: number | null;
  positionPct: number | null;
  /** How long the command has stood, for the mismatch's grace period. */
  sinceChangeMs: number | null;
}

/** Live values by connector name. */
export interface Frame {
  samples: Record<string, Sample>;
  valves: Record<string, ValveSample>;
  offlineBoards: number[];
}

/** Where a frame's values come from: the live store, a recording, a test. */
export interface FrameSource {
  sample(entity: string, component: string): Sample;
  valve(roleEntity: string, ballValve: boolean): Omit<ValveSample, 'sinceChangeMs'>;
  boardOffline(boardId: number): boolean;
  /** When the commanded state was last seen to change, per name; kept by the caller. */
  sinceChange(name: string, open: boolean | null): number | null;
}

/** A frame for every cabled connector, read from `src`. */
export function frameOf(pid: StandPid, names: Map<string, DaqName>, src: FrameSource): Frame {
  const samples: Record<string, Sample> = {};
  const valves: Record<string, ValveSample> = {};
  const boards = new Set<number>();
  for (const c of pid.channels) {
    const type = pid.symbols[c.symbol]?.type ?? '';
    const kind = kindOf(type);
    const daq = names.get(fold(c.name));
    if (daq?.boardId != null) boards.add(daq.boardId);
    if (kind === 'pressure') samples[c.name] = src.sample(pressureEntity(c.name), 'pressure_psi');
    else if (kind === 'temperature') samples[c.name] = src.sample(temperatureEntity(c.name, type), 'temperature_c');
    else if (kind === 'valve') {
      const v = src.valve(`ACT.${entityName(c.name)}`, Boolean(daq?.ballValve));
      valves[c.name] = { ...v, sinceChangeMs: src.sinceChange(c.name, v.open) };
    }
  }
  return { samples, valves, offlineBoards: [...boards].filter((b) => src.boardOffline(b)) };
}

// ── What is painted ──────────────────────────────────────────────────────────

export type ReadingState = 'live' | 'stale' | 'none' | 'unknown';

export interface Reading {
  symbol: string;
  name: string;
  kind: 'pressure' | 'temperature';
  /** Anchor, stand pixels: centre of the symbol's top edge, after nudging. */
  x: number;
  y: number;
  text: string;
  state: ReadingState;
  /** Why it is not live, for a tooltip and the health list. */
  note?: string;
}

export interface Ring {
  symbol: string;
  name: string;
  cx: number;
  cy: number;
  r: number;
  open: boolean | null;
  stale: boolean;
  /** Commanded and sensed disagree past the grace period. */
  mismatch: string | null;
  /** Ball valve: "% open" beside the valve. */
  position: string | null;
  /** Drawing and DAQ config disagree on NO/NC: the DAQ's, said. */
  disagree: string | null;
  /** Where the position/disagree line goes (below the valve, nudged clear of other labels). */
  labelY: number;
}

export interface LineStyle {
  color: string;
  dashed: boolean;
}

export interface LegendRow {
  section: string;
  source: string;
}

export interface Overlay {
  /** Symbols with no cable: drawn, dimmed. */
  dim: Box[];
  /** Symbols on a board that has stopped answering. */
  offline: Box[];
  readings: Reading[];
  rings: Ring[];
  /** Line id to its section's shade. */
  lines: Record<string, LineStyle>;
  /** Two transducers on one section that disagree. */
  splits: { x: number; y: number; text: string }[];
  /** Which limit each shaded section is drawn against. */
  legend: LegendRow[];
  health: Health;
}

export interface Health {
  /** Bundle names the DAQ config does not know: the reading cannot be found. */
  unknown: string[];
  /** DAQ config names no connector in the bundle carries. */
  unplaced: string[];
  /** Valves whose NO/NC the drawing gives differently from the DAQ. */
  disagree: string[];
}

/** Coil current above which a solenoid counts as energised. An assumption: a 12/24 V coil holding
 *  draws hundreds of mA, an off one reads noise. */
export const COIL_ON_A = 0.1;
/** How long a solenoid may take to follow its command before a mismatch is raised. */
export const COIL_GRACE_MS = 750;
/** A motorised ball valve travels for seconds. */
export const BALL_VALVE_GRACE_MS = 10_000;
/** A ball valve counts as open/closed within this of its end. */
export const BALL_VALVE_END_PCT = 10;
/** Two transducers on one section disagree past the larger of this and 5 % of its limit. */
export const SPLIT_PSI = 25;

/** "512" (psig, as the page footer says), or a dash when there is no value. */
export function psigText(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '—' : `${Math.round(v)}`;
}

export function celsiusText(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '— °C' : `${v.toFixed(1)} °C`;
}

/** "4 s", "2 min": how old a stale value is. */
export function ageText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'no data';
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

const isStale = (s: Pick<Sample, 'ageMs' | 'staleAfterMs'>) => s.ageMs === null || s.ageMs > s.staleAfterMs;

/** What a mismatch is, or null: the sensed state against the command, after its grace. */
export function valveMismatch(v: ValveSample, daq: DaqName | undefined): string | null {
  if (v.open === null || !daq || v.sinceChangeMs === null) return null;
  if (daq.ballValve) {
    if (v.positionPct === null || v.sinceChangeMs < BALL_VALVE_GRACE_MS) return null;
    if (v.open && v.positionPct < 100 - BALL_VALVE_END_PCT) return `commanded open, at ${Math.round(v.positionPct)}%`;
    if (!v.open && v.positionPct > BALL_VALVE_END_PCT) return `commanded shut, at ${Math.round(v.positionPct)}%`;
    return null;
  }
  if (v.currentA === null || v.sinceChangeMs < COIL_GRACE_MS) return null;
  // The sequencer sends position; the coil is energised for open on NC, shut on NO.
  const energised = v.open !== (daq.normally === 'NO');
  const drawing = v.currentA >= COIL_ON_A;
  if (energised && !drawing) return `coil commanded on, ${v.currentA.toFixed(2)} A`;
  if (!energised && drawing) return `coil commanded off, ${v.currentA.toFixed(2)} A`;
  return null;
}

// Shading: cool near 0, warm toward the limit, red at it. Through teal, not straight from blue
// to yellow: that blend passes through grey, and a third-of-limit section read as unmeasured.
const STOPS: [number, [number, number, number]][] = [
  [0, [96, 165, 250]],
  [0.35, [45, 212, 191]],
  [0.6, [250, 204, 21]],
  [0.85, [251, 146, 60]],
  [1, [239, 68, 68]],
];
export const UNMEASURED = '#6b7280';

/** The shade for a fraction of a section's limit. */
export function shade(fraction: number): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  for (let i = 1; i < STOPS.length; i++) {
    const [f1, c1] = STOPS[i];
    const [f0, c0] = STOPS[i - 1];
    if (f <= f1) {
      const t = (f - f0) / (f1 - f0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return 'rgb(239, 68, 68)';
}

export interface OverlayOptions {
  /** Height of one line of overlay text, in stand pixels (the view computes it from its scale). */
  lineHeight?: number;
}

/** What to paint over the drawing for this frame. */
export function overlayOf(pid: StandPid, frame: Frame, names: Map<string, DaqName> = new Map(), opts: OverlayOptions = {}): Overlay {
  const lineHeight = opts.lineHeight ?? 30;
  const cabled = new Set(pid.channels.map((c) => c.symbol));
  const offlineBoards = new Set(frame.offlineBoards);
  const dim: Box[] = [];
  const offline: Box[] = [];
  for (const [id, box] of Object.entries(pid.boxes)) if (!cabled.has(id)) dim.push(box);

  const health: Health = { unknown: [], unplaced: [], disagree: [] };
  const readings: Reading[] = [];
  const rings: Ring[] = [];

  for (const c of pid.channels) {
    const box = pid.boxes[c.symbol];
    const sym = pid.symbols[c.symbol];
    const kind = kindOf(sym?.type ?? '');
    if (!box || !kind) continue;
    const daq = names.get(fold(c.name));
    if (names.size && !daq) health.unknown.push(c.name);
    const boardDown = daq?.boardId != null && offlineBoards.has(daq.boardId);
    if (boardDown) offline.push(box);

    if (kind === 'valve') {
      const v = frame.valves[c.name];
      const daqNormally = daq?.normally ?? null;
      const disagree = daqNormally && sym.normally && sym.normally !== daqNormally ? `DAQ: ${daqNormally}` : null;
      if (disagree) health.disagree.push(`${c.name} (drawing ${sym.normally}, DAQ ${daqNormally})`);
      rings.push({
        symbol: c.symbol,
        name: c.name,
        cx: box[0] + box[2] / 2,
        cy: box[1] + box[3] / 2,
        r: Math.max(box[2], box[3]) / 2 + 6,
        open: v?.open ?? null,
        stale: !v || boardDown || isStale(v),
        mismatch: v && !boardDown && !isStale(v) ? valveMismatch(v, daq) : null,
        position: daq?.ballValve && v?.positionPct != null ? `${Math.round(v.positionPct)}% open` : null,
        disagree,
        labelY: 0,
      });
      continue;
    }

    const s = frame.samples[c.name];
    const fmt = kind === 'pressure' ? psigText : celsiusText;
    let state: ReadingState;
    let text: string;
    let note: string | undefined;
    if (names.size && !daq) {
      state = 'unknown';
      text = fmt(null);
      note = `"${c.name}" is not a name in the DAQ config`;
    } else if (!s || s.value === null) {
      state = 'none';
      text = fmt(null);
      note = boardDown ? 'board offline' : 'no data yet';
    } else if (boardDown || isStale(s)) {
      state = 'stale';
      text = `${fmt(s.value)} · ${ageText(s.ageMs)}`;
      note = boardDown ? 'board offline' : `last value ${ageText(s.ageMs)} ago`;
    } else {
      state = 'live';
      text = fmt(s.value);
    }
    readings.push({ symbol: c.symbol, name: c.name, kind, x: box[0] + box[2] / 2, y: box[1], text, state, note });
  }

  if (names.size) {
    const carried = new Set(pid.channels.map((c) => fold(c.name)));
    for (const [k, d] of names) if (!carried.has(k)) health.unplaced.push(d.name);
  }

  const { lines, splits, legend } = shadeSections(pid, frame, names);

  // One placement pass for every label, so a ring's "DAQ: NO" and a reading
  // above the next symbol do not land on each other. Ring labels hang below
  // their ring and move down; readings sit above their symbol and move up.
  const ringLabels = rings
    .filter((r) => r.position || r.disagree)
    .map((r) => ({ id: `ring:${r.symbol}`, x: r.cx, y: r.cy + r.r + lineHeight, text: [r.position, r.disagree].filter(Boolean).join(' · '), dir: 1 as const }));
  const placed = placeAll(
    [...ringLabels, ...readings.map((r) => ({ id: `reading:${r.symbol}`, x: r.x, y: r.y, text: r.text, dir: -1 as const }))],
    lineHeight,
  );
  for (const r of rings) r.labelY = placed.get(`ring:${r.symbol}`) ?? r.cy + r.r + lineHeight;
  const placedReadings = readings.map((r) => ({ ...r, y: placed.get(`reading:${r.symbol}`) ?? r.y }));
  return { dim, offline, readings: placedReadings, rings, lines, splits, legend, health };
}

/**
 * Each section's shade: its highest live transducer against its limit. A
 * section no transducer reads is dashed -- the DAQ is blind there, which is not
 * the same as empty.
 */
export function shadeSections(pid: StandPid, frame: Frame, names: Map<string, DaqName>): Pick<Overlay, 'lines' | 'splits' | 'legend'> {
  const lines: Record<string, LineStyle> = {};
  const splits: Overlay['splits'] = [];
  const legend: LegendRow[] = [];
  if (!pid.sections) return { lines, splits, legend };

  const bySection = new Map<string, { name: string; symbol: string }[]>();
  for (const c of pid.channels) {
    const s = pid.sectionOf?.[c.symbol];
    if (s && kindOf(pid.symbols[c.symbol]?.type ?? '') === 'pressure') {
      bySection.set(s, [...(bySection.get(s) ?? []), { name: c.name, symbol: c.symbol }]);
    }
  }

  for (const [id, section] of Object.entries(pid.sections)) {
    const pts = bySection.get(id) ?? [];
    let style: LineStyle;
    if (!pts.length) {
      style = { color: UNMEASURED, dashed: true };
    } else {
      const live = pts
        .map((p) => ({ ...p, s: frame.samples[p.name] }))
        .filter((p) => p.s && p.s.value !== null && !isStale(p.s));
      const scale = Math.min(
        ...pts.map((p) => names.get(fold(p.name))?.fullScalePsi ?? DEFAULT_PT_FULL_SCALE_PSI),
      );
      const limit = section.limit ? { psig: section.limit.psig, source: limitSource(section.limit) } : { psig: scale, source: 'transducer full scale' };
      if (!live.length) {
        style = { color: UNMEASURED, dashed: false };
      } else {
        const high = Math.max(...live.map((p) => p.s!.value!));
        style = { color: shade(high / limit.psig), dashed: false };
        if (live.length > 1) {
          const low = Math.min(...live.map((p) => p.s!.value!));
          if (high - low > Math.max(SPLIT_PSI, 0.05 * limit.psig)) {
            const box = pid.boxes[live[0].symbol];
            if (box) splits.push({ x: box[0] + box[2], y: box[1], text: `${Math.round(high - low)} psi apart` });
          }
        }
      }
      if (section.limit) legend.push({ section: pts.map((p) => p.name).join(' / '), source: `${Math.round(limit.psig)} psig, ${limit.source}` });
    }
    for (const line of section.lines) lines[line] = style;
  }
  return { lines, splits, legend };
}

export interface Label {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Which way it moves to get clear: -1 up (a reading above its symbol), 1 down. */
  dir: -1 | 1;
}

/**
 * Every label moved, in its own direction, until none overlaps another: on a
 * whole stand at 27 %, symbols a few apart put their labels on top of each
 * other. Widths are estimated from character count (a monospace face).
 * Returns each label's final baseline by id.
 */
export function placeAll(labels: Label[], lineHeight: number): Map<string, number> {
  const charW = lineHeight * 0.62;
  const placed: { x: number; y: number; w: number }[] = [];
  const out = new Map<string, number>();
  const order = [...labels].sort((a, b) => (a.dir - b.dir) || (b.y - a.y) * a.dir * -1 || a.x - b.x);
  for (const l of order) {
    const w = l.text.length * charW;
    let y = l.y;
    for (let guard = 0; guard < 30; guard++) {
      const hit = placed.find((p) => Math.abs(p.x - l.x) < (p.w + w) / 2 && Math.abs(p.y - y) < lineHeight);
      if (!hit) break;
      y = hit.y + l.dir * lineHeight;
    }
    placed.push({ x: l.x, y, w });
    out.set(l.id, y);
  }
  return out;
}

/** Readings alone, moved up clear of each other. */
export function placeLabels(readings: Reading[], lineHeight: number): Reading[] {
  const ys = placeAll(readings.map((r) => ({ id: r.symbol, x: r.x, y: r.y, text: r.text, dir: -1 })), lineHeight);
  return readings.map((r) => ({ ...r, y: ys.get(r.symbol) ?? r.y }));
}

/**
 * The page's own stylesheet for the drawing's lines: each section's shade,
 * scoped by line id. `width` is in the line's own units: a line drawn 2 px
 * wide on a stand fitted at 27 % is half a pixel on screen and its colour
 * cannot be seen, so the view passes a width that comes out a few screen
 * pixels wide. Dashes are scaled with it.
 */
export function lineStyles(lines: Record<string, LineStyle>, width?: number): string {
  const rules: string[] = [];
  const w = width && Number.isFinite(width) && width > 0 ? width : null;
  const dash = w ? `${(w * 2.5).toFixed(2)} ${(w * 2).toFixed(2)}` : '6 6';
  for (const [id, s] of Object.entries(lines)) {
    const sel = `[data-pid-line="${id.replace(/["\\]/g, '\\$&')}"] path.react-flow__edge-path`;
    rules.push(
      `${sel}{stroke:${s.color} !important;${w ? `stroke-width:${w.toFixed(2)}px !important;` : ''}` +
        `${s.dashed ? `stroke-dasharray:${dash} !important;` : ''}}`,
    );
  }
  return rules.join('\n');
}

/** The valve colours: open, shut, and a state too old to trust or not yet known. */
export const VALVE_COLOURS = { open: '#22c55e', shut: '#ef4444', stale: '#6b7280' } as const;

/** A valve's colour, and whether its stroke is dashed (stale or no state yet). */
export function valveColour(r: Pick<Ring, 'open' | 'stale'>): { color: string; dashed: boolean } {
  if (r.open === null || r.stale) return { color: VALVE_COLOURS.stale, dashed: true };
  return { color: r.open ? VALVE_COLOURS.open : VALVE_COLOURS.shut, dashed: false };
}

/**
 * CSS that paints each valve's own drawn shape (not its tag text) in its
 * state's colour. The symbol is `[data-pid-symbol]`, a plain <g> in a synthetic
 * drawing and a react-flow node (HTML around an inline <svg>) in a real
 * export, so the rule reaches the SVG shapes at any depth beneath it. `width`
 * is in the symbol's own units, as for lineStyles: the drawn stroke is too thin
 * at a whole-stand fit for its colour to be seen.
 */
export function valveStyles(rings: Ring[], width?: number): string {
  const shapes = 'path,line,polyline,polygon,rect,circle,ellipse';
  const w = width && Number.isFinite(width) && width > 0 ? width : null;
  const dash = w ? `${(w * 2).toFixed(2)} ${(w * 1.3).toFixed(2)}` : '4 3';
  const rules: string[] = [];
  for (const r of rings) {
    const { color, dashed } = valveColour(r);
    const id = r.symbol.replace(/["\\]/g, '\\$&');
    const sel = shapes.split(',').map((s) => `[data-pid-symbol="${id}"] ${s}`).join(',');
    rules.push(
      `${sel}{stroke:${color} !important;${w ? `stroke-width:${w.toFixed(2)}px !important;` : ''}` +
        `${dashed ? `stroke-dasharray:${dash} !important;` : ''}}`,
    );
  }
  return rules.join('\n');
}

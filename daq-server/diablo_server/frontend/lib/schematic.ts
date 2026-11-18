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
 * Pressures are gauge, as the DAQ logs them, and always say so: "psig".
 *
 * The bundle's shape is feed-twin's (`feed-twin/frontend/src/lib/daqBundle.ts`);
 * this is the DAQ's copy of it, checked by `FORMAT`.
 */

export const FORMAT = 'star.stand-pid/1';

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
  normally: 'NO' | 'NC' | null;
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

/** A connector name as the store keys it: "Ox Upstream" -> "Ox_Upstream". */
export const entityName = (name: string) => name.trim().replace(/\s+/g, '_');

/** The store key a transducer's calibrated pressure is read from. */
export const pressureEntity = (name: string) => `PT_Cal.${entityName(name)}`;

/** What reads a pressure on the drawing. */
const PRESSURE = new Set(['PT']);

/** Live values by connector name; null is "no fresh value". */
export type Frame = Record<string, number | null>;

/** The connectors whose value the page reads, by kind. */
export function pressureChannels(pid: StandPid): BundleChannel[] {
  return pid.channels.filter((c) => PRESSURE.has(pid.symbols[c.symbol]?.type ?? ''));
}

/** A frame off whatever reads a value: the live store, or a recording. */
export function frameOf(pid: StandPid, read: (entity: string, component: string) => number | null): Frame {
  const out: Frame = {};
  for (const c of pressureChannels(pid)) out[c.name] = read(pressureEntity(c.name), 'pressure_psi');
  return out;
}

export interface Reading {
  symbol: string;
  name: string;
  /** Anchor: centre of the symbol's top edge, stand pixels. */
  x: number;
  y: number;
  text: string;
  live: boolean;
}

export interface Overlay {
  /** Symbols with no cable: drawn, dimmed. */
  dim: Box[];
  readings: Reading[];
}

/** "512 psig", or a dash when there is no fresh value. Never bare "psi". */
export function psigText(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '— psig' : `${Math.round(v)} psig`;
}

/** What to paint over the drawing for this frame. */
export function overlayOf(pid: StandPid, frame: Frame): Overlay {
  const cabled = new Set(pid.channels.map((c) => c.symbol));
  const dim = Object.entries(pid.boxes)
    .filter(([id]) => !cabled.has(id))
    .map(([, box]) => box);
  const readings: Reading[] = [];
  for (const c of pressureChannels(pid)) {
    const box = pid.boxes[c.symbol];
    if (!box) continue;
    const v = frame[c.name] ?? null;
    readings.push({
      symbol: c.symbol,
      name: c.name,
      x: box[0] + box[2] / 2,
      y: box[1],
      text: psigText(v),
      live: v !== null,
    });
  }
  return { dim, readings };
}

/**
 * The P&ID as pid-designer saved it (GET /api/layerx/drawings/{id}/document), read into what the
 * schematic draws: symbols with a kind, lines between them, and the instruments clipped to them.
 *
 * Only the topology and the author's positions are used. Nothing is inferred about the plumbing
 * (lengths, bores, heights stay the drawing's): the schematic is a picture of the drawing, the same
 * one feedtwin assembled the network from, so its ids are the network's (a line is the branch of the
 * same id, an inline symbol the branch of its own id, a tank or manifold the node of its id).
 */

export type SymbolKind =
  | 'bottle' | 'dewar' | 'tank' | 'regulator' | 'solenoid' | 'valve' | 'check' | 'relief' | 'qd'
  | 'manifold' | 'junction' | 'vent' | 'engine' | 'instrument';

export interface Param { value: number; unit: string }

export interface DSymbol {
  id: string;
  /** pid-designer's componentType (KBOTTLE, PR, SOL, ...). */
  type: string;
  kind: SymbolKind;
  label: string;
  fluid: string | null;
  /** Drawing units, as placed. */
  x: number;
  y: number;
  /** An instrument's host symbol. */
  attachedTo: string | null;
  options: Record<string, string>;
  params: Record<string, Param>;
}

export interface DLine {
  id: string;
  from: string;
  to: string;
  params: Record<string, Param>;
}

export interface Drawing {
  symbols: DSymbol[];
  lines: DLine[];
  byId: Map<string, DSymbol>;
}

/** The document endpoint's body. */
export interface DrawingDocument {
  id: string;
  name: string;
  sha256: string;
  document: { nodes?: unknown[]; edges?: unknown[] };
}

const KIND: Record<string, SymbolKind> = {
  KBOTTLE: 'bottle', DEWAR: 'dewar', TANK: 'tank', PR: 'regulator', SOL: 'solenoid', MAN: 'valve', ROT: 'valve',
  CV: 'check', RV: 'relief', QD: 'qd', MANIFOLD: 'manifold', JUNCTION: 'junction', VENT: 'vent', ENGINE: 'engine',
  PT: 'instrument', TC: 'instrument', RTD: 'instrument', PG: 'instrument', LC: 'instrument',
};

/** Symbols a line passes through: a valve, a regulator, a check. Their state is drawn. */
export const INLINE: ReadonlySet<SymbolKind> = new Set(['regulator', 'solenoid', 'valve', 'check', 'relief', 'qd']);
/** Symbols that only join lines: they carry no drop of their own. */
export const JOIN: ReadonlySet<SymbolKind> = new Set(['manifold', 'junction']);
/** Valves whose state is open/shut. */
export const SWITCHED: ReadonlySet<SymbolKind> = new Set(['solenoid', 'valve']);

/** The propellants a tank can hold, as pid-designer names fluids. */
const PRESSURANTS = new Set(['nitrogen', 'helium', 'air', 'argon']);
export const isPressurant = (fluid: string | null | undefined) => !!fluid && PRESSURANTS.has(fluid.toLowerCase());

const rec = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

function params(raw: unknown): Record<string, Param> {
  const out: Record<string, Param> = {};
  const o = rec(raw);
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) {
    const p = rec(v);
    if (p && typeof p.value === 'number' && Number.isFinite(p.value)) out[k] = { value: p.value, unit: typeof p.unit === 'string' ? p.unit : '' };
  }
  return out;
}

function strings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const o = rec(raw);
  if (o) for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * The document's symbols and lines. Tolerant: a node with no id or position, an annotation (text,
 * section box) or an unknown type is left out; a line to a symbol that is not drawn, or a clip line
 * to an instrument, is left out (an instrument is drawn by its `attachedTo`).
 */
export function parseDrawing(doc: DrawingDocument['document'] | null | undefined): Drawing {
  const symbols: DSymbol[] = [];
  for (const raw of doc?.nodes ?? []) {
    const n = rec(raw);
    const pos = rec(n?.position);
    const data = rec(n?.data) ?? {};
    const id = typeof n?.id === 'string' ? n.id : null;
    const type = typeof data.componentType === 'string' ? data.componentType : typeof n?.type === 'string' ? n.type : '';
    const kind = KIND[type];
    if (!id || !pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !kind) continue;
    symbols.push({
      id, type, kind,
      label: typeof data.label === 'string' && data.label.trim() ? data.label.trim() : id,
      fluid: typeof data.fluid === 'string' ? data.fluid : null,
      x: pos.x, y: pos.y,
      attachedTo: typeof data.attachedTo === 'string' ? data.attachedTo : null,
      options: strings(data.options),
      params: params(data.params),
    });
  }
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const lines: DLine[] = [];
  const seen = new Set<string>();
  for (const raw of doc?.edges ?? []) {
    const e = rec(raw);
    const id = typeof e?.id === 'string' ? e.id : null;
    const from = typeof e?.source === 'string' ? e.source : null;
    const to = typeof e?.target === 'string' ? e.target : null;
    if (!id || !from || !to || from === to || seen.has(id)) continue;
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b || a.kind === 'instrument' || b.kind === 'instrument') continue;
    seen.add(id);
    lines.push({ id, from, to, params: params(rec(e?.data)?.params) });
  }
  return { symbols, lines, byId };
}

/** Lines meeting a symbol, with the symbol at the other end. */
export function neighbours(d: Drawing, id: string): { line: DLine; other: DSymbol; out: boolean }[] {
  const out: { line: DLine; other: DSymbol; out: boolean }[] = [];
  for (const l of d.lines) {
    if (l.from === id) { const o = d.byId.get(l.to); if (o) out.push({ line: l, other: o, out: true }); }
    else if (l.to === id) { const o = d.byId.get(l.from); if (o) out.push({ line: l, other: o, out: false }); }
  }
  return out;
}

/** Regulators that load another regulator's dome (a PR whose outlet is a PR marked dome-loaded). */
export function domeLoaders(d: Drawing): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of d.lines) {
    const a = d.byId.get(l.from);
    const b = d.byId.get(l.to);
    if (a?.kind === 'regulator' && b?.kind === 'regulator' && b.options.domeLoaded === 'yes') m.set(a.id, b.id);
  }
  return m;
}

/**
 * Whether a line meeting a tank is on its liquid side: the other end holds the tank's propellant
 * (a main valve, a fill), not a pressurant (a press or vent line). With no fluid stated, a line is
 * liquid when it leads to an engine without passing another tank.
 */
export function isLiquidLine(d: Drawing, tank: DSymbol, line: DLine): boolean {
  const otherId = line.from === tank.id ? line.to : line.from;
  const other = d.byId.get(otherId);
  if (!other) return false;
  if (other.fluid) return !isPressurant(other.fluid);
  return reachesEngine(d, otherId, new Set([tank.id]));
}

function reachesEngine(d: Drawing, start: string, seen: Set<string>): boolean {
  const stack = [start];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = d.byId.get(id);
    if (!s) continue;
    if (s.kind === 'engine') return true;
    if (s.kind === 'tank' || s.kind === 'bottle' || s.kind === 'dewar') continue;
    for (const n of neighbours(d, id)) stack.push(n.other.id);
  }
  return false;
}

/** A symbol's in-line axis, from where its neighbours sit: a valve between two symbols left and right is horizontal. */
export function axisOf(d: Drawing, s: DSymbol, skip: ReadonlySet<string> = new Set()): 'h' | 'v' {
  let dx = 0;
  let dy = 0;
  for (const n of neighbours(d, s.id)) {
    if (skip.has(n.line.id)) continue;
    dx += Math.abs(n.other.x - s.x);
    dy += Math.abs(n.other.y - s.y);
  }
  return dy > dx ? 'v' : 'h';
}

/** The line's two ends as words: "TK-LOX → MV-OX". */
export function lineName(d: Drawing, l: DLine): string {
  const a = d.byId.get(l.from)?.label ?? l.from;
  const b = d.byId.get(l.to)?.label ?? l.to;
  return `${a} → ${b}`;
}

/**
 * The DAQ box panel's arithmetic, kept out of the components so it can be
 * tested: where a connector sits in the grid, what a board's dropdown says,
 * what is under the pointer when a cable is let go, and why a symbol is
 * refused.
 *
 * Plus a very small store for what the panel and the drawing share while a
 * cable is being drawn (the connector being dragged, the symbol under the
 * pointer, the one hovered). Kept outside React state so a drag re-renders
 * only what reads it, and only when the symbol under the pointer changes.
 */

import type { BoardDef, BoardId, ChannelDef, HookupSymbol, SymbolKind } from '../api';
import { DEFAULT_ROWS, type Draft, PER_ROW, isValveBoard, opensIn, removeRow, rowsOf } from './hookupDraft';

/** A connector: a board and its number on it (from 1). */
export interface Slot {
  board: BoardId;
  slot: number;
}

export const sameSlot = (a: Slot | null | undefined, b: Slot | null | undefined) =>
  Boolean(a && b && a.board === b.board && a.slot === b.slot);

/** What a badge on the drawing calls each board: short enough to sit over a
 *  symbol. */
export const BOARD_SHORT: Record<BoardId, string> = {
  sol12: 'S12',
  sol24: 'S24',
  pt_low: 'PT-L',
  pt_high: 'PT-H',
  rtd: 'RTD',
  tc: 'TC',
};

/** "S12·3": a connector, as its badge on the drawing reads. */
export const badge = (c: Slot) => `${BOARD_SHORT[c.board]}·${c.slot}`;

/** Connectors are numbered in reading order, five to a row. */
export const slotAt = (row: number, col: number) => row * PER_ROW + col + 1;
export const cellOf = (slot: number) => ({ row: Math.floor((slot - 1) / PER_ROW), col: (slot - 1) % PER_ROW });

/** Every connector a board shows, in order. */
export function slotsOf(d: Draft, board: BoardId): number[] {
  return Array.from({ length: rowsOf(d, board) * PER_ROW }, (_, i) => i + 1);
}

/** Connectors in use on a board, and how many it shows. */
export function usage(d: Draft, board: BoardId): { used: number; slots: number } {
  return { used: d.channels.filter((c) => c.board === board).length, slots: rowsOf(d, board) * PER_ROW };
}

/** "Solenoids 12V · 7/10" -- a board as the dropdown lists it. */
export function boardOption(d: Draft, def: BoardDef): string {
  const { used, slots } = usage(d, def.id);
  return `${def.label} · ${used}/${slots}`;
}

/** Whether the last row can go: only an empty row past the first two. */
export function canDropRow(d: Draft, board: BoardId): boolean {
  const highest = Math.max(0, ...d.channels.filter((c) => c.board === board).map((c) => c.slot));
  return rowsOf(d, board) > Math.max(DEFAULT_ROWS, Math.ceil(highest / PER_ROW));
}

/** A cable moves only between boards that take the same thing. */
export const sameKind = (a: BoardDef | undefined, b: BoardDef | undefined) => Boolean(a && b && a.kind === b.kind);

// ------------------------------------------------------------- the refusal

const KIND: Record<SymbolKind, { a: string; board: string }> = {
  valve: { a: 'a valve', board: 'a solenoid board' },
  pt: { a: 'a PT', board: 'a PT board' },
  rtd: { a: 'an RTD', board: 'the RTD board' },
  tc: { a: 'a TC', board: 'the TC board' },
};

export type Verdict = { ok: true } | { ok: false; why: string };

/**
 * Whether a symbol may be cabled to a board, and if not, why -- in the words
 * a person would use: "FU-PT-R is a PT — it plugs into a PT board".
 * `drawn` is the drawing's own tag and type, for the symbols the box takes
 * nothing from (a tank, a gauge, a hand valve).
 */
export function verdict(
  board: BoardDef | undefined,
  symbol: HookupSymbol | undefined,
  drawn?: { tag: string; type: string },
): Verdict {
  if (!board) return { ok: false, why: 'No board.' };
  if (!symbol) {
    const tag = drawn?.tag || 'That';
    const type = drawn?.type ? ` (${drawn.type})` : '';
    return { ok: false, why: `${tag}${type} doesn't plug into the DAQ box` };
  }
  if (symbol.kind === board.kind) return { ok: true };
  return { ok: false, why: `${symbol.label} is ${KIND[symbol.kind].a} — it plugs into ${KIND[symbol.kind].board}` };
}

// ---------------------------------------------------------- the hit-testing

/** Drawn things that are not symbols: a section box, a note, a tee. */
export const NOT_TARGETS: ReadonlySet<string> = new Set(['REGION', 'TEXT', 'JUNCTION']);

/** The little of the DOM a hit-test needs, so it can be tested without one. */
export interface Hit {
  closest(selector: string): Hit | null;
  getAttribute(name: string): string | null;
}

/**
 * The symbol under a point of the screen, on the drawing `inside` accepts:
 * React Flow draws each symbol as `.react-flow__node[data-id]` (a symbol on
 * another page is not drawn at all). Section boxes, notes and tees are not
 * targets, nor is anything off the drawing.
 */
export function symbolUnder<E extends Hit>(
  doc: { elementFromPoint(x: number, y: number): E | null },
  x: number,
  y: number,
  inside: (el: Hit) => boolean,
  typeOf: (id: string) => string | undefined,
): string | null {
  const node = doc.elementFromPoint(x, y)?.closest('.react-flow__node') ?? null;
  if (!node || !inside(node)) return null;
  const id = node.getAttribute('data-id');
  if (!id) return null;
  return NOT_TARGETS.has(typeOf(id) ?? '') ? null : id;
}

/** The connector under a point, if it is one of the box's
 *  (`[data-daq-board][data-daq-slot]`). */
export function connectorUnder<E extends Hit>(
  doc: { elementFromPoint(x: number, y: number): E | null },
  x: number,
  y: number,
): Slot | null {
  const cell = doc.elementFromPoint(x, y)?.closest('[data-daq-slot]') ?? null;
  const board = cell?.getAttribute('data-daq-board') as BoardId | null | undefined;
  const slot = Number(cell?.getAttribute('data-daq-slot'));
  return board && slot >= 1 ? { board, slot } : null;
}

/** Where the board on show is remembered, per browser. */
export const BOARD_KEY = 'feedtwin.pid.daqBoard';

/** A press becomes a drag past this many pixels; less is a click. */
export const DRAG_PX = 4;
export const pastClick = (dx: number, dy: number) => dx * dx + dy * dy > DRAG_PX * DRAG_PX;

// --------------------------------------------------------- the stray row

/** A state-table row the last cable made, for its connector's tag, before
 *  anyone named it. */
export interface FreshRow {
  symbol: string;
  /** The row the plug made for the twin's guess, if the table had none. */
  row: string | null;
}

const fold = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Drop the row a cable made a moment ago if nothing uses it any more: the
 * connector was renamed onto a row the table already had ("LOX Main"), or
 * pulled out again. A row that opens somewhere, or that a connector still
 * goes by, is somebody's and stays.
 */
export function dropFreshRow(d: Draft, fresh: FreshRow | null): Draft {
  const row = fresh?.row;
  if (!row || !d.machine.actuators.includes(row)) return d;
  const named = d.channels.some((c) => isValveBoard(c.board) && fold(c.name) === fold(row));
  if (named || opensIn(d.machine, row).length > 0) return d;
  return { ...d, machine: removeRow(d.machine, row) };
}

/** The channel a symbol is cabled to, as its badge says it. */
export const badgeOf = (channels: readonly ChannelDef[], symbol: string): string | null => {
  const c = channels.find((x) => x.symbol === symbol);
  return c ? badge(c) : null;
};

/** "LOX Main is S12·1 → OM-R": the connector that already goes by a name,
 *  said under the field it is being typed in. Null when none does (case
 *  ignored, as `nameTaken`). */
export function clashNote(d: Draft, name: string, except: string, tagOf: (id: string) => string): string | null {
  const n = fold(name);
  if (!n) return null;
  const c = d.channels.find((x) => x.symbol !== except && fold(x.name) === n);
  return c ? `${c.name} is ${badge(c)} → ${tagOf(c.symbol)}` : null;
}

// ------------------------------------------------------------ the badges

/** A badge on the drawing is 10 px monospace: ~6 px a character, and 10 px
 *  of padding and border. */
const BADGE_CHAR = 6;
const BADGE_PAD = 10;
/** Badges whose centres are closer than this in height share a line. */
const BADGE_LINE = 18;
/** Space kept between two badges on one line. */
const BADGE_GAP = 6;

export const badgeWidth = (text: string) => text.length * BADGE_CHAR + BADGE_PAD;

/** The width a badge centred at `at` may take [flow px] without running into
 *  one of `others` on about the same line: for two badges centred `dx`
 *  apart, each may be `dx` less the gap wide. At most `most`. */
export function badgeRoom(at: { x: number; y: number }, others: readonly { x: number; y: number }[], most = 180): number {
  let room = most;
  for (const o of others) {
    if (Math.abs(o.y - at.y) < BADGE_LINE) room = Math.min(room, Math.abs(o.x - at.x) - BADGE_GAP);
  }
  return room;
}

/** What a symbol's badge says: "S12·1 LOX Main" when `room` allows, the name
 *  cut short when only part of it fits, the connector alone when less. The
 *  overlay takes no pointer, so a hover could never say the name. */
export function badgeLabel(c: ChannelDef, room: number): string {
  const head = badge(c);
  const full = `${head} ${c.name}`;
  if (badgeWidth(full) <= room) return full;
  // The space and the ellipsis take two.
  const chars = Math.floor((room - BADGE_PAD) / BADGE_CHAR) - head.length - 2;
  return chars >= 3 ? `${head} ${c.name.slice(0, chars).trimEnd()}…` : head;
}

// ---------------------------------------------------------------- the store

export interface Store<T> {
  get: () => T;
  /** Merge a patch; subscribers hear only of a real change. */
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const p = typeof patch === 'function' ? patch(state) : patch;
      const keys = Object.keys(p) as (keyof T)[];
      if (!keys.some((k) => !Object.is(p[k], state[k]))) return;
      state = { ...state, ...p };
      subs.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** What the DAQ box panel and the drawing share. */
export interface DaqUi {
  /** The board on show (null: the first). */
  board: BoardId | null;
  /** The plugged connector whose details are open. */
  selected: Slot | null;
  /** An empty connector waiting for a symbol to be clicked. */
  armed: Slot | null;
  /** A symbol clicked on the drawing that is not on the box: the next empty
   *  connector clicked takes it. */
  picked: string | null;
  /** A cable being drawn from an empty connector, or a plugged one being
   *  carried to another. */
  drag: (Slot & { moving: boolean }) | null;
  /** The symbol under the pointer during a cable drag, and whether it fits. */
  target: { id: string; ok: boolean } | null;
  /** The connector under the pointer while one is carried. */
  over: number | null;
  /** The symbol of the connector under the mouse. */
  hover: string | null;
  /** Bring a symbol into view on the drawing (n: a new request). */
  show: { id: string; n: number } | null;
  /** Bumped to put the cursor in the selected connector's name. */
  naming: number;
  /** One line under the board: why a drop was refused, or what moved. */
  note: { text: string; bad: boolean } | null;
  /** The row the last cable made for its tag, until it is named. */
  fresh: FreshRow | null;
}

export const DAQ_UI: DaqUi = {
  board: null,
  selected: null,
  armed: null,
  picked: null,
  drag: null,
  target: null,
  over: null,
  hover: null,
  show: null,
  naming: 0,
  note: null,
  fresh: null,
};

/** A store nobody writes: for a panel shown without the DAQ box beside it. */
export const NO_UI: Store<DaqUi> = createStore<DaqUi>({ ...DAQ_UI });

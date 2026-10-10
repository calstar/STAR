/**
 * The hookup being edited, as plain data, and every edit as a pure function.
 *
 * Three things, joined by NAME, as the real DAQ declares them:
 *
 *  - the DAQ box: boards of GX12 connectors, each cabled to one symbol;
 *  - each connector's name -- what the console calls it and, on a solenoid
 *    board, the state table's row;
 *  - the state table: which rows each state opens, and the legal moves.
 *
 * So wiring OM-R to a 12 V connector named "LOX Main" makes it the valve the
 * table's "LOX Main" row opens -- in Fire, and in the aborts. Renaming the
 * connector carries its row with it; a name that is already a row joins that
 * row. The Symbols panel, the DAQ box and the State machine tab all edit one
 * of these, so switching between them changes nothing.
 */

import type {
  BoardDef,
  BoardId,
  ChannelDef,
  HookupBody,
  HookupSymbol,
  MachineDef,
  MachineStateDef,
} from '../api';

/** Connectors per row on every board. */
export const PER_ROW = 5;
/** Rows a board shows before anybody adds one. */
export const DEFAULT_ROWS = 2;
/** Columns of the console's state grid (StateMachineDiagram). */
export const PANEL_COLS = 5;

/** A hookup as the panels edit it: always a box, always a table. */
export interface Draft extends HookupBody {
  channels: ChannelDef[];
  machine: MachineDef;
}

const fold = (s: string) => s.trim().toLocaleLowerCase();

/** Solenoid boards: their connectors' names are the table's rows. */
export const isValveBoard = (board: BoardId) => board === 'sol12' || board === 'sol24';

// ------------------------------------------------------------------ the box

export function channelOf(d: Draft, symbol: string): ChannelDef | undefined {
  return d.channels.find((c) => c.symbol === symbol);
}

export function channelAt(d: Draft, board: BoardId, slot: number): ChannelDef | undefined {
  return d.channels.find((c) => c.board === board && c.slot === slot);
}

/** Whether a symbol plugs into a board: a solenoid board drives valves, a PT
 *  board reads transducers, and so on. 12 V and 24 V, low and high
 *  pressure, are the person's to tell apart; neither refuses the other's. */
export function accepts(board: BoardDef | undefined, symbol: HookupSymbol | undefined): boolean {
  return Boolean(board && symbol && board.kind === symbol.kind);
}

/** How many rows of connectors a board shows: what was asked for, and never
 *  fewer than its highest cable needs. */
export function rowsOf(d: Draft, board: BoardId): number {
  const highest = Math.max(0, ...d.channels.filter((c) => c.board === board).map((c) => c.slot));
  return Math.max(DEFAULT_ROWS, d.rows?.[board] ?? 0, Math.ceil(highest / PER_ROW));
}

/** The lowest empty connector on a board (it may be past the rows shown). */
export function freeSlot(d: Draft, board: BoardId): number {
  let slot = 1;
  while (channelAt(d, board, slot)) slot += 1;
  return slot;
}

/** Whether another connector already goes by this name (case ignored, as a
 *  person reads it). */
export function nameTaken(d: Draft, name: string, except?: string): boolean {
  const n = fold(name);
  return d.channels.some((c) => c.symbol !== except && fold(c.name) === n);
}

/** `name`, or `name (2)`, ... -- the first no other connector has. */
export function uniqueName(d: Draft, name: string, except?: string): string {
  let out = name.trim() || 'Unnamed';
  for (let n = 2; nameTaken(d, out, except); n += 1) out = `${name.trim()} (${n})`;
  return out;
}

/** The table's rows nothing is wired to: the names a valve connector could
 *  take to join a row that already says when it opens. */
export function unwiredRows(d: Draft): string[] {
  const wired = new Set(d.channels.filter((c) => isValveBoard(c.board)).map((c) => fold(c.name)));
  return d.machine.actuators.filter((a) => !wired.has(fold(a)));
}

/** The table's own spelling of a name, if it has the row (case ignored). */
export function rowNamed(m: MachineDef, name: string): string | undefined {
  const n = fold(name);
  return m.actuators.find((a) => fold(a) === n);
}

/**
 * Cable `symbol` to a connector (the lowest free one on `board` if `slot` is
 * not given). A symbol already on the box moves, keeping its name; a new one
 * takes `name`, or its tag. On a solenoid board the name is a row: one the
 * table has is joined (in the table's spelling), and a new one gets a row
 * that opens in no state yet -- ready to tick on the State machine tab.
 * A connector already taken is left alone: the caller asks first.
 */
export function wire(
  d: Draft,
  symbol: HookupSymbol,
  board: BoardId,
  slot?: number,
  name?: string,
): Draft {
  const at = slot ?? freeSlot(d, board);
  const there = channelAt(d, board, at);
  if (there && there.symbol !== symbol.id) return d;
  const before = channelOf(d, symbol.id);
  const others = d.channels.filter((c) => c.symbol !== symbol.id);
  const wanted = (name ?? before?.name ?? symbol.label).trim() || symbol.label;
  const spelled = isValveBoard(board) ? (rowNamed(d.machine, wanted) ?? wanted) : wanted;
  const chosen = uniqueName({ ...d, channels: others }, spelled, symbol.id);
  const machine = isValveBoard(board) ? addRow(d.machine, chosen) : d.machine;
  const channel: ChannelDef = { board, slot: at, name: chosen, symbol: symbol.id };
  return { ...d, machine, channels: [...others, channel] };
}

/** Pull a symbol's cable. Its row stays in the table (it commands nothing
 *  until something is wired to that name again). */
export function unwire(d: Draft, symbol: string): Draft {
  return { ...d, channels: d.channels.filter((c) => c.symbol !== symbol) };
}

/** Pull every cable: the box empty, the table as it was. */
export function unwireAll(d: Draft): Draft {
  return { ...d, channels: [] };
}

/** Move a cable to another connector; onto a taken one, the two swap. Only
 *  between boards that take the same kind (the caller checks). */
export function move(d: Draft, from: { board: BoardId; slot: number }, to: { board: BoardId; slot: number }): Draft {
  const a = channelAt(d, from.board, from.slot);
  if (!a || (from.board === to.board && from.slot === to.slot)) return d;
  const b = channelAt(d, to.board, to.slot);
  return {
    ...d,
    channels: d.channels.map((c) => {
      if (c === a) return { ...c, board: to.board, slot: to.slot };
      if (b && c === b) return { ...c, board: from.board, slot: from.slot };
      return c;
    }),
  };
}

/**
 * Rename a symbol's connector. On a solenoid board the name is its row, so:
 * a name the table already has joins that row (its spelling kept), and the
 * row it leaves goes too if no state opens it (the blank row wiring made for
 * its tag); otherwise the row it had is renamed with it, so it still opens
 * where it did.
 *
 * `carry` false is for a name the twin only guessed a moment ago (a cable
 * just plugged, named by the twin's matching): the person is correcting the
 * guess, not renaming the table's row. The guessed row stays as the table
 * has it, and the new name joins its own row or gets a new, blank one.
 *
 * Returns the draft unchanged for an empty name or one another connector has.
 */
export function rename(d: Draft, symbol: string, name: string, carry = true): Draft {
  const c = channelOf(d, symbol);
  const wanted = name.trim();
  if (!c || !wanted || nameTaken(d, wanted, symbol)) return d;
  let machine = d.machine;
  let chosen = wanted;
  if (isValveBoard(c.board)) {
    const existing = rowNamed(machine, wanted);
    const own = rowNamed(machine, c.name);
    if (!carry && !(own && fold(own) === fold(wanted))) {
      if (existing) chosen = existing;
      else machine = addRow(machine, wanted);
    } else if (existing && existing !== own) {
      chosen = existing;
      if (own && opensIn(machine, own).length === 0) machine = removeRow(machine, own);
    } else if (own && fold(own) === fold(wanted)) {
      // "Lox Main" for "LOX Main": the same row as a person reads it (the
      // twin binds ignoring case), so the table keeps its spelling and stays
      // the DAQ's own.
    } else if (own) machine = renameRow(machine, own, wanted);
    else machine = addRow(machine, wanted);
  }
  return { ...d, machine, channels: d.channels.map((x) => (x === c ? { ...x, name: chosen } : x)) };
}

/** A console name for a symbol that is not on the box (a tank, the engine). */
export function setAlias(d: Draft, id: string, name: string): Draft {
  const aliases = { ...(d.aliases ?? {}) };
  if (name.trim()) aliases[id] = name;
  else delete aliases[id];
  return { ...d, aliases };
}

export function setRows(d: Draft, board: BoardId, rows: number): Draft {
  const needed = Math.ceil(Math.max(0, ...d.channels.filter((c) => c.board === board).map((c) => c.slot)) / PER_ROW);
  return { ...d, rows: { ...(d.rows ?? {}), [board]: Math.max(DEFAULT_ROWS, needed, rows) } };
}

// ---------------------------------------------------------------- the table

/** The states a row is OPEN in, in column order. */
export function opensIn(m: MachineDef, actuator: string): string[] {
  return m.states.map((s) => s.name).filter((s) => (m.open[s] ?? []).includes(actuator));
}

export function isOpen(m: MachineDef, actuator: string, state: string): boolean {
  return (m.open[state] ?? []).includes(actuator);
}

export function setOpen(m: MachineDef, actuator: string, state: string, open: boolean): MachineDef {
  const now = m.open[state] ?? [];
  const next = open
    ? m.actuators.filter((a) => a === actuator || now.includes(a))
    : now.filter((a) => a !== actuator);
  return { ...m, open: { ...m.open, [state]: next } };
}

export function canGo(m: MachineDef, from: string, to: string): boolean {
  return (m.allowed[from] ?? []).includes(to);
}

/** Allow or forbid one move. A state with no row in the transition table
 *  gets one (itself, as the DAQ writes a new row) the first time it is
 *  given a move. */
export function setAllowed(m: MachineDef, from: string, to: string, on: boolean): MachineDef {
  const now = m.allowed[from] ?? [from];
  const names = m.states.map((s) => s.name);
  const next = on ? names.filter((s) => s === to || now.includes(s)) : now.filter((s) => s !== to);
  return { ...m, allowed: { ...m.allowed, [from]: next } };
}

export function addRow(m: MachineDef, name: string): MachineDef {
  if (rowNamed(m, name)) return m;
  return { ...m, actuators: [...m.actuators, name.trim()] };
}

/** Drop a row, and every cell of it. */
export function removeRow(m: MachineDef, name: string): MachineDef {
  return {
    ...m,
    actuators: m.actuators.filter((a) => a !== name),
    open: Object.fromEntries(Object.entries(m.open).map(([s, rows]) => [s, rows.filter((a) => a !== name)])),
  };
}

export function renameRow(m: MachineDef, from: string, to: string): MachineDef {
  const swap = (a: string) => (a === from ? to : a);
  return {
    ...m,
    actuators: m.actuators.map(swap),
    open: Object.fromEntries(Object.entries(m.open).map(([s, rows]) => [s, rows.map(swap)])),
  };
}

/** The first spot on the panel no state takes, row by row. */
function freeSpot(m: MachineDef): [number, number] {
  const taken = new Set(m.states.filter((s) => s.row != null && s.col != null).map((s) => `${s.row}:${s.col}`));
  for (let row = 0; ; row += 1) {
    for (let col = 0; col < PANEL_COLS; col += 1) if (!taken.has(`${row}:${col}`)) return [row, col];
  }
}

/** A new state, as the DAQ adds one: opens nothing, may go only to itself,
 *  in the first free spot on the panel. */
export function addState(m: MachineDef, name?: string): MachineDef {
  const names = new Set(m.states.map((s) => fold(s.name)));
  let n = m.states.length + 1;
  let wanted = name?.trim() || `New state ${n}`;
  while (names.has(fold(wanted))) wanted = `New state ${++n}`;
  const [row, col] = freeSpot(m);
  return {
    ...m,
    states: [...m.states, { name: wanted, row, col, abort: false }],
    open: { ...m.open, [wanted]: [] },
    allowed: { ...m.allowed, [wanted]: [wanted] },
  };
}

/** Rename a state everywhere it is named: its column, its row of moves, and
 *  every move into it. Refused (unchanged) for an empty or taken name. */
export function renameState(m: MachineDef, from: string, to: string): MachineDef {
  const wanted = to.trim();
  if (!wanted || wanted === from) return m;
  if (m.states.some((s) => s.name !== from && fold(s.name) === fold(wanted))) return m;
  const swap = (s: string) => (s === from ? wanted : s);
  const rekey = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [swap(k), v]));
  return {
    ...m,
    states: m.states.map((s) => (s.name === from ? { ...s, name: wanted } : s)),
    open: rekey(m.open),
    allowed: Object.fromEntries(Object.entries(m.allowed).map(([k, v]) => [swap(k), v.map(swap)])),
  };
}

export function removeState(m: MachineDef, name: string): MachineDef {
  const drop = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== name));
  return {
    ...m,
    states: m.states.filter((s) => s.name !== name),
    open: drop(m.open),
    allowed: Object.fromEntries(
      Object.entries(m.allowed)
        .filter(([k]) => k !== name)
        .map(([k, v]) => [k, v.filter((s) => s !== name)]),
    ),
  };
}

/** Move a state one column left or right in the tables. */
export function moveState(m: MachineDef, name: string, by: -1 | 1): MachineDef {
  const i = m.states.findIndex((s) => s.name === name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= m.states.length) return m;
  const states = [...m.states];
  [states[i], states[j]] = [states[j], states[i]];
  return { ...m, states };
}

export function setState(m: MachineDef, name: string, patch: Partial<Omit<MachineStateDef, 'name'>>): MachineDef {
  return { ...m, states: m.states.map((s) => (s.name === name ? { ...s, ...patch } : s)) };
}

/** States the twin itself keys on by name, and why: renaming or removing
 *  one would quietly stop what it does. Their cells and moves stay
 *  editable. */
export function lockReason(name: string): string {
  const n = name.toLowerCase();
  if (n === 'idle') return 'Every stand opens in Idle, and the twin holds it shut (de-energised).';
  if (n === 'ready') return 'T-0 primes the stand in Ready, and the pad guide leads to it.';
  if (n === 'fire') return 'Fire is the burn: the engine lights and the burn is recorded.';
  if (n === 'vent') return 'A tank running dry in Fire sends the stand to Vent.';
  if (n === 'engine abort') return 'The console’s ENG ABORT button goes to Engine Abort.';
  if (n.includes('fill') && /(^|\s)(ox|lox|fuel|eth)/.test(n))
    return 'The twin’s loading follows the fill states by name (a tank fills in its own).';
  return '';
}

/** Two tables the same, cell for cell (order of OPEN rows ignored). */
export function sameMachine(a: MachineDef, b: MachineDef): boolean {
  const norm = (m: MachineDef) =>
    JSON.stringify({
      states: m.states.map((s) => [s.name, s.row ?? null, s.col ?? null, Boolean(s.abort)]),
      actuators: m.actuators,
      open: m.states.map((s) => [...(m.open[s.name] ?? [])].sort()),
      allowed: m.states.map((s) => (s.name in m.allowed ? [...m.allowed[s.name]].sort() : null)),
    });
  return norm(a) === norm(b);
}

/** What the DAQ would complain about: rows nothing is wired to (they command
 *  nothing) and valve connectors with no row (no state ever moves them). */
export function tableIssues(d: Draft): { unwired: string[]; rowless: ChannelDef[] } {
  const rows = new Set(d.machine.actuators.map(fold));
  return {
    unwired: unwiredRows(d),
    rowless: d.channels.filter((c) => isValveBoard(c.board) && !rows.has(fold(c.name))),
  };
}

// ------------------------------------------------------------ the DAQ's CSVs

const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** `state_machine_actuators.csv`, as the DAQ reads it. */
export function toActuatorCsv(m: MachineDef): string {
  const names = m.states.map((s) => s.name);
  const head = ['', ...names].map(cell).join(',');
  const rows = m.actuators.map((a) => [cell(a), ...names.map((s) => (isOpen(m, a, s) ? 'OPEN' : 'CLOSE'))].join(','));
  return [head, ...rows].join('\n') + '\n';
}

/** `state_transitions.csv`: row = the state you are in, column = where you
 *  may go. A state with no row in the table writes none. */
export function toTransitionCsv(m: MachineDef): string {
  const names = m.states.map((s) => s.name);
  const head = ['', ...names].map(cell).join(',');
  const rows = names
    .filter((s) => s in m.allowed)
    .map((s) => [cell(s), ...names.map((t) => (canGo(m, s, t) ? '1' : '0'))].join(','));
  return [head, ...rows].join('\n') + '\n';
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => r.map((c) => c.trim()));
}

/**
 * The DAQ's CSVs read into a table. The actuator file sets the states (its
 * header) and the rows; a state this table already had keeps its place on
 * the panel and its abort flag. The transition file, if given, is read the
 * way the DAQ reads it: a short row left-aligned.
 */
export function fromCsv(m: MachineDef, actuatorsCsv: string, transitionsCsv?: string): MachineDef {
  const rows = parseCsv(actuatorsCsv);
  if (rows.length === 0) throw new Error('The actuator table is empty.');
  const names = rows[0].slice(1).filter(Boolean);
  if (names.length === 0) throw new Error('The actuator table has no states in its first row.');
  const before = new Map(m.states.map((s) => [s.name, s]));
  const states: MachineStateDef[] = names.map(
    (name) => before.get(name) ?? { name, row: null, col: null, abort: /abort/i.test(name) },
  );
  const actuators = rows.slice(1).map((r) => r[0]).filter(Boolean);
  const open: Record<string, string[]> = Object.fromEntries(names.map((s) => [s, [] as string[]]));
  for (const r of rows.slice(1)) {
    names.forEach((s, j) => {
      if ((r[j + 1] ?? '').toUpperCase().startsWith('OPEN')) open[s].push(r[0]);
    });
  }
  let allowed: Record<string, string[]> = Object.fromEntries(
    names.filter((s) => s in m.allowed).map((s) => [s, m.allowed[s].filter((t) => names.includes(t))]),
  );
  if (transitionsCsv) {
    const t = parseCsv(transitionsCsv);
    const cols = (t[0] ?? []).slice(1);
    allowed = {};
    for (const r of t.slice(1)) {
      if (!names.includes(r[0])) continue;
      allowed[r[0]] = cols.filter((c, j) => names.includes(c) && (r[j + 1] ?? '') === '1');
    }
  }
  return { ...m, states, actuators, open, allowed };
}

/**
 * The State machine tab's own reading of the table: which of the DAQ's two
 * CSVs a dropped file is, where each state sits on the console's grid, and
 * which rows a connector drives. Pure; every edit is still hookupDraft's.
 */

import type { ChannelDef, MachineDef, MachineStateDef } from '../api';
import { PANEL_COLS, fromCsv, isValveBoard, parseCsv, toActuatorCsv } from './hookupDraft';

const fold = (s: string) => s.trim().toLocaleLowerCase();

export type CsvKind = 'actuators' | 'transitions';

/** The DAQ's third table, `state_machine_actuator_delays.csv`: states across,
 *  actuators down, seconds in the cells. Its zeros read like a transition
 *  table's, so it is told apart by its name. */
const DELAYS = /delay/i;

/** A file's rows and cells, read as the DAQ reads them (quotes, a BOM). */
const rowsOf = (text: string) => parseCsv(text.replace(/^\uFEFF/, ''));

/** The rows of a 0/1 file that are not states of its own first row: a
 *  transition table's rows are its columns, read the other way. */
function strangers(rows: string[][]): string[] {
  const states = new Set((rows[0] ?? []).slice(1).filter(Boolean));
  return rows
    .slice(1)
    .map((r) => r[0])
    .filter((k) => k && !states.has(k));
}

/**
 * Which of the DAQ's files this is, by its first data row: OPEN/CLOSE cells
 * are `state_machine_actuators.csv`, 0/1 cells `state_transitions.csv`. The
 * file's name decides only for a table with no rows; a row that is neither
 * is neither, whatever the file is called. The DAQ's delay table is never
 * either, nor is a 0/1 table whose rows are not states of its own header.
 */
export function csvKind(text: string, fileName = ''): CsvKind | null {
  if (DELAYS.test(fileName)) return null;
  const rows = rowsOf(text);
  const row = rows[1];
  if (row) {
    const cells = row
      .slice(1)
      .map((c) => c.toUpperCase())
      .filter(Boolean);
    if (cells.some((c) => c.startsWith('OPEN') || c.startsWith('CLOSE'))) return 'actuators';
    if (cells.length > 0 && cells.every((c) => c === '0' || c === '1') && strangers(rows).length === 0)
      return 'transitions';
    return null;
  }
  if (/transition/i.test(fileName)) return 'transitions';
  if (/actuator/i.test(fileName)) return 'actuators';
  return null;
}

/** Why a file is not one of the DAQ's two state tables, in a line. */
function notATable(name: string, text: string): string {
  if (DELAYS.test(name)) {
    return `${name}: the DAQ's actuator delays, which the twin does not read. Upload state_machine_actuators.csv and state_transitions.csv.`;
  }
  const odd = strangers(rowsOf(text));
  if (odd.length) {
    const shown = odd.slice(0, 3).join(', ') + (odd.length > 3 ? ', …' : '');
    return `${name}: rows ${shown} are not states in its first row, so it is not a transition table.`;
  }
  return `${name}: not a DAQ state table (no OPEN/CLOSE or 0/1 cells).`;
}

/** The DAQ's delay table picked with the two state tables -- the natural
 *  pick from its folder -- is passed over (by name), not refused: the twin
 *  does not read delays. Alone it is still refused, with why. */
export function skippedDelays(files: { name: string }[]): string[] {
  const delays = files.filter((f) => DELAYS.test(f.name)).map((f) => f.name);
  return delays.length < files.length ? delays : [];
}

/**
 * One or both of the DAQ's CSVs read into `m` (hookupDraft.fromCsv). With
 * only the transition file, the actuator table stays as it is. Throws, with
 * the file named, for a file that is neither or for two of one kind.
 */
export function applyCsvFiles(m: MachineDef, files: { name: string; text: string }[]): MachineDef {
  let actuators: string | undefined;
  let transitions: string | undefined;
  for (const f of files.filter((x) => !skippedDelays(files).includes(x.name))) {
    const text = f.text.replace(/^\uFEFF/, '');
    const kind = csvKind(text, f.name);
    if (!kind) throw new Error(notATable(f.name, text));
    if (kind === 'actuators') {
      if (actuators !== undefined) throw new Error('Two actuator tables: upload one.');
      actuators = text;
    } else {
      if (transitions !== undefined) throw new Error('Two transition tables: upload one.');
      transitions = text;
    }
  }
  if (actuators === undefined && transitions === undefined) throw new Error('No file.');
  return fromCsv(m, actuators ?? toActuatorCsv(m), transitions);
}

export interface PanelGrid {
  /** States with both a row and a column. */
  placed: (MachineStateDef & { row: number; col: number })[];
  /** States with no place: not on the console's grid. */
  off: string[];
  rows: number;
  cols: number;
  /** State -> the other states on the same spot. */
  clash: Map<string, string[]>;
}

/** The console's state grid as the table lays it out: PANEL_COLS wide (more
 *  if a state sits further right, so nothing is dropped), as many rows as
 *  the lowest state needs. */
export function panelGrid(states: MachineStateDef[]): PanelGrid {
  const placed = states.filter(
    (s): s is MachineStateDef & { row: number; col: number } => s.row != null && s.col != null,
  );
  const at = new Map<string, string[]>();
  for (const s of placed) {
    const key = `${s.row}:${s.col}`;
    at.set(key, [...(at.get(key) ?? []), s.name]);
  }
  const clash = new Map<string, string[]>();
  for (const names of at.values()) {
    if (names.length > 1) for (const n of names) clash.set(n, names.filter((x) => x !== n));
  }
  return {
    placed,
    off: states.filter((s) => s.row == null || s.col == null).map((s) => s.name),
    rows: Math.max(1, ...placed.map((s) => s.row + 1)),
    cols: Math.max(PANEL_COLS, ...placed.map((s) => s.col + 1)),
    clash,
  };
}

/** A table row and the solenoid connector that goes by its name, if any. */
export interface RowWiring {
  name: string;
  channel?: ChannelDef;
}

/** The table's rows (`MachineDef.actuators`) split as the tab lists them:
 *  wired (a solenoid connector has the row's name, case ignored) then not,
 *  each in table order. */
export function rowGroups(rows: string[], channels: ChannelDef[]): { wired: RowWiring[]; unwired: RowWiring[] } {
  const byName = new Map(channels.filter((c) => isValveBoard(c.board)).map((c) => [fold(c.name), c]));
  const wired: RowWiring[] = [];
  const unwired: RowWiring[] = [];
  for (const name of rows) {
    const channel = byName.get(fold(name));
    if (channel) wired.push({ name, channel });
    else unwired.push({ name });
  }
  return { wired, unwired };
}

/** Whether the twin holds this state shut whatever its column says. */
export const heldShut = (state: string) => fold(state) === 'idle';

/** The states whose own row of the transition table goes to no abort (a
 *  state with no row goes nowhere at all). The twin admits an abort from
 *  anywhere; the DAQ goes only where the cells say. An abort state is not
 *  asked, and a table with no aborts flagged has nothing to reach. */
export function withoutAbort(m: MachineDef): string[] {
  const aborts = m.states.filter((s) => s.abort).map((s) => s.name);
  if (aborts.length === 0) return [];
  return m.states
    .filter((s) => !s.abort && !aborts.some((a) => (m.allowed[s.name] ?? []).includes(a)))
    .map((s) => s.name);
}

/**
 * The state table's warnings, grouped: the seven "X -> Fire is permitted ...
 * bypasses Ready" sentences become one line naming the states, and every
 * other warning shows its first sentence with the rest on hover.
 */
export function groupTableWarnings(warnings: readonly string[]): { text: string; detail: string }[] {
  const bypass: string[] = [];
  const out: { text: string; detail: string }[] = [];
  let bypassDetail = '';
  for (const w of warnings) {
    const m = /^(.+?) -> Fire is permitted/.exec(w);
    if (m) {
      bypass.push(m[1]);
      bypassDetail = w.replace(/^.+? -> /, 'X -> ');
      continue;
    }
    const first = w.split(/(?<=\.)\s/)[0] ?? w;
    out.push({ text: first, detail: w });
  }
  if (bypass.length) {
    out.unshift({
      text: `${bypass.length} state${bypass.length === 1 ? '' : 's'} can go straight to Fire without Ready: ${bypass.join(', ')}.`,
      detail: bypassDetail,
    });
  }
  return out;
}

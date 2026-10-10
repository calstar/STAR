/**
 * The State machine tab's own reading of the table: which of the DAQ's two
 * CSVs a dropped file is, where each state sits on the console's grid, and
 * which rows a connector drives. Pure; every edit is still hookupDraft's.
 */

import type { ChannelDef, MachineDef, MachineStateDef } from '../api';
import { PANEL_COLS, fromCsv, isValveBoard, toActuatorCsv } from './hookupDraft';

const fold = (s: string) => s.trim().toLocaleLowerCase();

export type CsvKind = 'actuators' | 'transitions';

/**
 * Which of the DAQ's files this is, by its first data row: OPEN/CLOSE cells
 * are `state_machine_actuators.csv`, 0/1 cells `state_transitions.csv`. The
 * file's name decides only for a table with no rows; a row that is neither
 * is neither, whatever the file is called.
 */
export function csvKind(text: string, fileName = ''): CsvKind | null {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const row = lines[1];
  if (row) {
    // A quoted name may hold a comma; the cells after it never do.
    const cells = row
      .replace(/"(?:[^"]|"")*"/g, 'name')
      .split(',')
      .slice(1)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (cells.some((c) => c.startsWith('OPEN') || c.startsWith('CLOSE'))) return 'actuators';
    if (cells.length > 0 && cells.every((c) => c === '0' || c === '1')) return 'transitions';
    return null;
  }
  if (/transition/i.test(fileName)) return 'transitions';
  if (/actuator/i.test(fileName)) return 'actuators';
  return null;
}

/**
 * One or both of the DAQ's CSVs read into `m` (hookupDraft.fromCsv). With
 * only the transition file, the actuator table stays as it is. Throws, with
 * the file named, for a file that is neither or for two of one kind.
 */
export function applyCsvFiles(m: MachineDef, files: { name: string; text: string }[]): MachineDef {
  let actuators: string | undefined;
  let transitions: string | undefined;
  for (const f of files) {
    const text = f.text.replace(/^\uFEFF/, '');
    const kind = csvKind(text, f.name);
    if (!kind) throw new Error(`${f.name}: not a DAQ state table (no OPEN/CLOSE or 0/1 cells).`);
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

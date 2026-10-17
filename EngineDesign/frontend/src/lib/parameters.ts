import { PA_PER_PSI, psiUnitFor } from './pressure';

/**
 * Helpers for the Parameters workspace (components/ParametersWorkspace.tsx). Pure, so they can be
 * tested without a DOM: turning a row's dotted path into the nested update PUT /api/config merges,
 * parsing what was typed against the row's type, labels, and the search/filter.
 */

export interface ParameterRow {
  path: string;
  section: string;
  kind: 'field' | 'block' | 'undeclared';
  type: string;
  choices: (string | number | boolean | null)[] | null;
  value: unknown;
  default: unknown;
  required: boolean;
  modified: boolean;
  unit: string | null;
  description: string;
}

export interface ParameterSection {
  key: string;
  label: string;
  count: number;
  modified: number;
  /** Superseded by another section, kept so an old file loads (absent from an older server). */
  legacy?: boolean;
  /** Written by the app for itself, never by a person. */
  internal?: boolean;
}

/** The sections the workspace lists: a legacy one only while it holds a value, an internal one
 *  never. Their rows stay reachable through search. */
export function listedSections(sections: ParameterSection[]): ParameterSection[] {
  return sections.filter((s) => !s.internal && (!s.legacy || s.modified > 0));
}

/** A section the design switches off (`enabled: false`: regenerative or film cooling on an
 *  ablative engine). Listed apart, under "Off in this design", so it can still be turned on. */
export function sectionIsOff(key: string, config: Record<string, unknown> | null | undefined): boolean {
  const s = config?.[key];
  return !!s && typeof s === 'object' && (s as { enabled?: unknown }).enabled === false;
}

/** A physics constant that lives in code (engine/pipeline/code_constants.py). Read-only here. */
export interface CodeConstant {
  name: string;
  value: string;
  where: string;
  meaning: string;
  category: string;
  affects_results: boolean;
}

export interface ParametersResponse {
  sections: ParameterSection[];
  parameters: ParameterRow[];
  constants: CodeConstant[];
}

/** 'discharge.oxidizer.orifice_l_over_d' -> {discharge: {oxidizer: {orifice_l_over_d: v}}} */
export function nestedUpdate(edits: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split('.');
    let node = out;
    keys.slice(0, -1).forEach((k) => {
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    });
    node[keys[keys.length - 1]] = value;
  }
  return out;
}

const nullable = (row: ParameterRow) => row.type.includes('null') || !row.required;
const isBool = (row: ParameterRow) => row.type.replace(' | null', '') === 'bool';
const isInt = (row: ParameterRow) => row.type.replace(' | null', '') === 'int';
const isNumber = (row: ParameterRow) => /^(float|int)( \| null)?$/.test(row.type) || row.type === 'float | int';

/** What was typed -> the value to send, or an error. Blank means null where null is allowed. */
export function parseInput(row: ParameterRow, text: string): { value?: unknown; error?: string } {
  const t = text.trim();
  if (t === '') return nullable(row) ? { value: null } : { error: 'required' };
  if (row.choices) {
    const hit = row.choices.find((c) => String(c) === t);
    return hit === undefined ? { error: `one of ${row.choices.join(', ')}` } : { value: hit };
  }
  if (isBool(row)) {
    if (t === 'true' || t === 'false') return { value: t === 'true' };
    return { error: 'true or false' };
  }
  if (isNumber(row)) {
    const v = Number(t);
    if (!Number.isFinite(v)) return { error: 'number' };
    if (isInt(row) && !Number.isInteger(v)) return { error: 'whole number' };
    return { value: v };
  }
  if (row.type === 'list' || row.type === 'dict' || row.type.startsWith('list') || row.type.startsWith('dict')) {
    try {
      return { value: JSON.parse(t) };
    } catch {
      return { error: 'JSON' };
    }
  }
  return { value: t };
}

/** How a value is shown in an input. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(10));
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Unit suffixes a key can carry ('max_lox_tank_pressure_psi'), and what they mean. */
const SUFFIX_UNITS: [RegExp, string][] = [
  [/_m_s$/, 'm/s'], [/_cal$/, 'cal'], [/_K$/, 'K'], [/_s$/, 's'], [/_psia$/, 'psia'], [/_psi$/, 'psi'], [/_mm2$/, 'mm²'], [/_mm$/, 'mm'], [/_m3$/, 'm³'], [/_m2$/, 'm²'],
  [/_m$/, 'm'], [/_kg$/, 'kg'], [/_deg$/, '°'], [/_pa$/, 'Pa'], [/_hz$/, 'Hz'], [/_um$/, 'µm'],
  [/_microns$/, 'µm'], [/_kg_m3$/, 'kg/m³'], [/_L$/, 'L'], [/_in$/, 'in'],
];

/** Words the team writes a particular way. */
const WORDS: Record<string, string> = {
  of: 'O/F', mr: 'O/F', lox: 'LOX', lstar: 'L*', cd: 'Cd', smd: 'SMD', cea: 'CEA', copv: 'COPV', dp: 'ΔP',
  od: 'OD', pc: 'Pc', cf: 'Cf', eps: 'ε', rp1: 'RP-1', we: 'We', re: 'Re', mw: 'MW', gn2: 'GN2', ld: 'L/d',
  l: 'L', d: 'd', o: 'O', f: 'F', w: 'Weight', cma: 'CMA', lbfgs: 'L-BFGS', dt: 'Dc/Dt', 'l/d': 'L/d',
  mom: 'momentum', ao: 'A_O', af: 'A_F', imp: 'impingement', dp_o: 'ΔP_O', dp_f: 'ΔP_F',
  frac: 'fraction', pos: 'position', temp: 'temperature',
};

/** The unit a key's name carries, when the schema description gives none. A `psi` field is an
 *  absolute pressure (psia) unless its name makes it a difference (a tolerance, a scale, an
 *  excursion), which stays psi; the stored number is the same either way. */
export function unitOf(row: ParameterRow): string | null {
  const k = row.path.split('.').pop() ?? '';
  let u = row.unit;
  if (!u) for (const [re, su] of SUFFIX_UNITS) if (re.test(k)) { u = su; break; }
  if (!u && /_psi_(min|max)$/.test(k)) u = 'psi';
  if (u === 'psi') return psiUnitFor(k);
  return u ?? null;
}

// A field stored in Pa that is not a pressure: a modulus or a strength, read in MPa / GPa.
const STRESS = /modulus|strength|stress/i;

/**
 * A Pa value as a person reads it, beside the stored number: an absolute pressure in psia, a
 * modulus or strength in MPa or GPa. Null for anything not in Pa, or nothing to show. A pair
 * (a range) is shown as one.
 */
export function friendlyValue(row: ParameterRow, v: unknown): string | null {
  // A length stored in metres reads in mm and inches: "0.1651 m" is a 6.5 in chamber.
  if (unitOf(row) === 'm') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return null;
    // An altitude or a rail is read in feet, not in millions of millimetres.
    if (Math.abs(v) >= 10) return `${Math.round(v / 0.3048).toLocaleString('en-US')} ft`;
    const mm = v * 1000;
    const inch = v / 0.0254;
    return `${+mm.toPrecision(4)} mm · ${+inch.toPrecision(4)} in`;
  }
  if (unitOf(row) !== 'Pa') return null;
  const k = row.path.split('.').pop() ?? '';
  const one = (x: unknown): string | null => {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (STRESS.test(k)) return x >= 1e9 ? `${+(x / 1e9).toPrecision(3)} GPa` : `${+(x / 1e6).toPrecision(3)} MPa`;
    const psi = x / PA_PER_PSI;
    return `${psi.toLocaleString('en-US', { maximumFractionDigits: psi < 100 ? 1 : 0 })} ${psiUnitFor(k)}`;
  };
  if (Array.isArray(v)) {
    const parts = v.map(one);
    return parts.length && parts.every((p) => p !== null) ? parts.join(' to ') : null;
  }
  return one(v);
}

/** Keys whose words do not read on their own. */
const LABELS: Record<string, string> = {
  max_P_tank_O: 'Max LOX tank pressure, absolute (blank: the psia field above)',
  max_P_tank_F: 'Max fuel tank pressure, absolute (blank: the psia field above)',
};

/** The last path segment, readable: 'max_lox_tank_pressure_psi' -> 'Max LOX tank pressure'. */
export function labelOf(path: string): string {
  let k = path.split('.').pop() ?? path;
  if (LABELS[k]) return LABELS[k];
  // 'layer1_P_O_start_psi_min' -> 'LOX tank pressure, search floor'.
  const tank = /^(?:layer1_)?P_([OF])_start_psi(?:_(min|max))?$/.exec(k);
  if (tank) {
    const bound = tank[2] === 'min' ? ', search floor' : tank[2] === 'max' ? ', search ceiling' : '';
    return `${tank[1] === 'O' ? 'LOX' : 'Fuel'} tank pressure${bound}`;
  }
  for (const [re] of SUFFIX_UNITS) {
    if (re.test(k) && k.replace(re, '').length > 0) { k = k.replace(re, ''); break; }
  }
  k = k.replace(/^layer1_/, '').replace(/_over_/g, '/');
  const words = k.split('_').filter(Boolean).map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const s = words.join(' ').replace(/ \/ /g, '/').replace(/(\w)\/(\w)/g, '$1/$2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The path minus its section and last segment: 'discharge.oxidizer.orifice_l_over_d' -> 'oxidizer'. */
export function groupOf(row: ParameterRow): string {
  const parts = row.path.split('.');
  return parts.slice(1, -1).join('.');
}

export type Filter = 'all' | 'modified' | 'unused-blocks';

export function matches(row: ParameterRow, query: string, filter: Filter): boolean {
  if (filter === 'modified' && !row.modified) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.path.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)
    || (row.unit ?? '').toLowerCase().includes(q);
}

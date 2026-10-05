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

/** The unit a key's name carries, when the schema description gives none. */
export function unitOf(row: ParameterRow): string | null {
  if (row.unit) return row.unit;
  const k = row.path.split('.').pop() ?? '';
  for (const [re, u] of SUFFIX_UNITS) if (re.test(k)) return u;
  return null;
}

/** The last path segment, readable: 'max_lox_tank_pressure_psi' -> 'Max LOX tank pressure'. */
export function labelOf(path: string): string {
  let k = path.split('.').pop() ?? path;
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

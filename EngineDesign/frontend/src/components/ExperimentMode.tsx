import { useState, useRef, useLayoutEffect, useMemo } from 'react';
import type { EngineConfig, TimeSeriesData, TimeSeriesSummary } from '../api/client';
import { API_BASE, getConfig, updateConfig } from '../api/client';
import { PressureCurveChart } from './PressureCurveChart';
import {
  ComposedChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

interface ExperimentModeProps {
  config: EngineConfig | null;
  onConfigUpdated?: (config: EngineConfig) => void;
}

interface RowInput {
  id: number;
  label: string;
  t0: string;
  tf: string;
  deltaP: string;   // psi
  weight: string;   // kg — cumulative tank weight reading
}

type ExperimentTab = 'cold_flow' | 'press_feed';

interface PressTestRowInput {
  id: number;
  tank: 'lox' | 'fuel';
  ullageFraction: string; // 0-1 (gas fraction)
  copvPStart: string;
  copvPEnd: string;
  copvTStart: string;
  copvTEnd: string;
  tankPStart: string;
  tankPEnd: string;
  tankTStart: string;
  tankTEnd: string;
}

interface PressTestRunResult {
  row_index: number;
  label: string;
  tank: 'lox' | 'fuel';
  cv_line_estimate: number;
  mdot_copv_avg: number;
  mdot_tank_avg: number;
  cross_check_ratio: number;
  copv_dp_psi: number;
  tank_dp_psi: number;
}

interface PressTestRowDiagnostic {
  row_index: number;
  label: string;
  tank: 'lox' | 'fuel';
  status: 'ok' | 'skipped';
  message: string;
}

interface PressTestFitResponse {
  rows: PressTestRunResult[];
  row_diagnostics?: PressTestRowDiagnostic[];
  cv_line_lox_fitted: number | null;
  cv_line_lox_std: number | null;
  cv_line_fuel_fitted: number | null;
  cv_line_fuel_std: number | null;
  cv_reg: number;
  cv_eff_lox: number | null;
  cv_eff_fuel: number | null;
  recommendation: string;
  save_available: boolean;
}

interface TimeseriesResponse {
  status: string;
  t: number[];
  results: {
    Pc: number[];
    mdot_O: number[];
    mdot_F: number[];
    F: number[];
    Isp: number[];
    MR: number[];
    Cd_O: number[];
    Cd_F: number[];
    delta_p_injector_O: number[];
    delta_p_injector_F: number[];
  };
  fuel_cda_pressure_pairs: [number, number][];
  lox_cda_pressure_pairs:  [number, number][];
  pressure_curves_used?: {
    P_tank_O_pa: number[];
    P_tank_F_pa: number[];
  };
  cda_fit?: {
    fuel: { model: string; a: number; b: number };
    lox: { model: string; a: number; b: number };
  };
  re_similarity?: {
    mean_re_water_fuel: number;
    mean_re_water_lox: number;
    mean_re_hotfire_fuel: number;
    mean_re_hotfire_lox: number;
    ratio_hotfire_to_water_fuel: number | null;
    ratio_hotfire_to_water_lox: number | null;
    fuel_within_two_orders: boolean;
    lox_within_two_orders: boolean;
  };
}

const PSI_TO_PA = 6894.757;

/** Strip surrounding "..." from CSV / Excel paste. */
function stripCsvQuotes(s: string): string {
  let t = (s ?? '').trim().replace(/^\uFEFF/, '');
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    t = t.slice(1, -1).replace(/""/g, '"');
  }
  return t.trim();
}

/** Normalize US-style numbers with thousands commas (e.g. "2,063.58") for parseFloat. */
function parseUsNumberString(raw: string): string {
  const t = stripCsvQuotes(raw);
  if (!t) return '';
  const sign = t.startsWith('-') ? '-' : '';
  const body = sign ? t.slice(1) : t;
  // Typical US Excel export: 1,234.56 or 2,048.65
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(body)) {
    return sign + body.replace(/,/g, '');
  }
  return t;
}

function parseUsFloat(raw: string): number {
  const s = parseUsNumberString(raw);
  if (!s) return NaN;
  return parseFloat(s);
}

function isLikelyAbsoluteDatetime(s: string): boolean {
  const t = stripCsvQuotes(s);
  return /\d{4}-\d{2}-\d{2}/.test(t) || /\d{1,2}\/\d{1,2}\/\d{4}/.test(t);
}

/** Split one CSV line respecting RFC4180-style double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Tab-separated (Excel row copy) or comma-separated CSV. */
function splitClipboardRow(line: string): string[] {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.includes('\t')) {
    return trimmed.split('\t').map((c) => stripCsvQuotes(c.trim()));
  }
  return parseCsvLine(trimmed);
}

function isPressFeedHeaderRow(cells: string[]): boolean {
  if (!cells.length) return false;
  const a = stripCsvQuotes(cells[0]).trim().toLowerCase();
  return a === 'tank' || a === 'branch';
}

/**
 * Convert the four time cells for a press row to seconds suitable for the fit API.
 * If all values look like absolute datetimes, shift by the earliest so windows stay compact.
 * Otherwise each cell: datetime → Unix seconds; plain number → seconds as-is (comma-stripped).
 */
function convertPressFourTimes(copvT0: string, copvTf: string, tankT0: string, tankTf: string): string[] {
  const raw = [copvT0, copvTf, tankT0, tankTf].map(stripCsvQuotes);
  const isDt = raw.map((s) => isLikelyAbsoluteDatetime(s));
  if (isDt.every(Boolean)) {
    const secs = raw.map((s) => {
      const ms = Date.parse(s.replace(' ', 'T'));
      return Number.isFinite(ms) ? ms / 1000 : NaN;
    });
    if (secs.every((x) => Number.isFinite(x))) {
      const tMin = Math.min(...secs);
      return secs.map((v) => (v - tMin).toFixed(6));
    }
  }
  return raw.map((s, i) => {
    if (isDt[i]) {
      const ms = Date.parse(s.replace(' ', 'T'));
      return Number.isFinite(ms) ? (ms / 1000).toFixed(6) : '';
    }
    const n = parseUsFloat(s);
    return Number.isFinite(n) ? String(n) : '';
  });
}

function fmtN(n: number, d = 4): string { return n.toFixed(d); }
function fmtSci(n: number): string {
  if (n === 0) return '0';
  return Math.abs(Math.floor(Math.log10(Math.abs(n)))) >= 4 ? n.toExponential(3) : n.toPrecision(4);
}
function avg(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type CellPos = { row: number; col: number };

interface InputCol {
  kind: 'input';
  key: string;
  inputKey: keyof Omit<RowInput, 'id' | 'label'>;
  header: string;
  width: number;
}
interface ComputedCol {
  kind: 'computed';
  key: string;
  header: string;
  width: number;
  compute: (row: RowInput, prevRow: RowInput | null, chokeDiamM: number, waterRho: number) => string;
  highlight?: (value: string) => 'good' | 'warn' | null;
}
type ColDef = InputCol | ComputedCol;

const COLS: ColDef[] = [
  { kind: 'input',    key: 't0',      inputKey: 't0',      header: 'T₀ [s]',      width: 90  },
  { kind: 'input',    key: 'tf',      inputKey: 'tf',      header: 'Tf [s]',       width: 90  },
  { kind: 'input',    key: 'deltaP',  inputKey: 'deltaP',  header: 'ΔP [psi]',     width: 95  },
  { kind: 'input',    key: 'weight',  inputKey: 'weight',  header: 'Weight [kg]',  width: 110 },
  {
    kind: 'computed', key: 'mdot', header: 'ṁ [kg/s]', width: 105,
    compute: (row, prevRow) => {
      const dt = parseFloat(row.tf) - parseFloat(row.t0);
      const dw = parseFloat(row.weight) - (prevRow ? parseFloat(prevRow.weight) : 0);
      if (!isFinite(dt) || dt <= 0 || !isFinite(dw) || dw < 0) return '—';
      return (dw / dt).toFixed(5);
    },
  },
  {
    kind: 'computed', key: 'cda_m2', header: 'CdA [m²]', width: 110,
    compute: (row, prevRow, _chokeDiamM, waterRho) => {
      const dt = parseFloat(row.tf) - parseFloat(row.t0);
      const dw = parseFloat(row.weight) - (prevRow ? parseFloat(prevRow.weight) : 0);
      const dp = parseFloat(row.deltaP) * PSI_TO_PA;
      if (!isFinite(dt) || dt <= 0 || !isFinite(dw) || dw < 0 || !isFinite(dp) || dp <= 0 || waterRho <= 0) return '—';
      const mdot = dw / dt;
      return (mdot / Math.sqrt(2 * waterRho * dp)).toExponential(4);
    },
  },
  {
    kind: 'computed', key: 'cn', header: 'CN', width: 75,
    compute: (row) => {
      const dp = parseFloat(row.deltaP) * PSI_TO_PA;
      if (!isFinite(dp) || dp <= 0) return '—';
      return (dp / 2337).toFixed(2);
    },
    highlight: (val) => val === '—' ? null : parseFloat(val) >= 2 ? 'good' : 'warn',
  },
];

const INPUT_COLS = COLS.filter((c): c is InputCol => c.kind === 'input');
const INPUT_COL_INDICES = COLS.map((c, i) => c.kind === 'input' ? i : -1).filter(i => i >= 0);
const FIRST_INPUT = INPUT_COL_INDICES[0];
const LAST_INPUT  = INPUT_COL_INDICES[INPUT_COL_INDICES.length - 1];

function newRow(n: number): RowInput {
  return { id: Date.now() + Math.random(), label: `Run ${n}`, t0: '', tf: '', deltaP: '', weight: '' };
}

function newPressRow(_n: number, tank: 'lox' | 'fuel' = 'lox'): PressTestRowInput {
  return {
    id: Date.now() + Math.random(),
    tank,
    ullageFraction: '',
    copvPStart: '', copvPEnd: '',
    copvTStart: '', copvTEnd: '',
    tankPStart: '', tankPEnd: '',
    tankTStart: '', tankTEnd: '',
  };
}

/** Strings for Pressure Feed system-parameter inputs, derived from loaded engine YAML. */
type PressFeedParamStrings = {
  copvVolumeL: string;
  tankVolumeLoxL: string;
  tankVolumeFuelL: string;
  tCopvK: string;
  tUllK: string;
  regCv: string;
  regDroop: string;
  regSetpoint: string;
  regInitialCopv: string;
};

function positiveNumToString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return String(v);
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return String(n);
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v != null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** Top-level section by exact name, then case-insensitive key match (YAML vs tooling). */
function pickSection(root: Record<string, unknown>, sectionName: string): Record<string, unknown> | undefined {
  const direct = asRecord(root[sectionName]);
  if (direct && Object.keys(direct).length > 0) return direct;
  const want = sectionName.toLowerCase();
  for (const [k, v] of Object.entries(root)) {
    if (k.toLowerCase() === want) {
      const r = asRecord(v);
      if (r && Object.keys(r).length > 0) return r;
    }
  }
  return undefined;
}

/** Numeric field on nested dict: exact keys first, then key matching regex (alias / hand-edited YAML). */
function pickNumericFieldLoose(
  obj: Record<string, unknown> | undefined,
  exactKeys: string[],
  looseKeyRegex?: RegExp,
): string | null {
  if (!obj) return null;
  for (const k of exactKeys) {
    const s = positiveNumToString(obj[k]);
    if (s) return s;
  }
  if (looseKeyRegex) {
    for (const k of Object.keys(obj)) {
      if (looseKeyRegex.test(k)) {
        const s = positiveNumToString(obj[k]);
        if (s) return s;
      }
    }
  }
  return null;
}

/** Stable fingerprint of all YAML slices that feed Pressure Feed system params. */
function pressFeedConfigSyncKey(cfg: EngineConfig | null): string {
  if (!cfg) return '';
  const r = cfg as Record<string, unknown>;
  const slice = {
    press_system: pickSection(r, 'press_system'),
    press_tank: pickSection(r, 'press_tank'),
    design_requirements: pickSection(r, 'design_requirements'),
    lox_tank: pickSection(r, 'lox_tank'),
    fuel_tank: pickSection(r, 'fuel_tank'),
    combustion: pickSection(r, 'combustion'),
    fluids: pickSection(r, 'fluids'),
  };
  try {
    return JSON.stringify(slice);
  } catch {
    return '';
  }
}

const PRESS_FEED_EMPTY_STATE: PressFeedParamStrings = {
  copvVolumeL: '',
  tankVolumeLoxL: '',
  tankVolumeFuelL: '',
  tCopvK: '',
  tUllK: '',
  regCv: '',
  regDroop: '',
  regSetpoint: '',
  regInitialCopv: '',
};

/**
 * Map active `EngineConfig` (YAML-backed) into press-test system fields.
 * Every field is pulled straight from the config; missing keys stay empty
 * so the UI makes it obvious what YAML is (and isn't) providing.
 */
function pressFeedSystemParamsFromConfig(config: EngineConfig | null): PressFeedParamStrings {
  const out: PressFeedParamStrings = { ...PRESS_FEED_EMPTY_STATE };
  if (!config) return out;
  const root = config as Record<string, unknown>;
  const pressTank = pickSection(root, 'press_tank');
  const dr = pickSection(root, 'design_requirements');
  const loxTank = pickSection(root, 'lox_tank');
  const fuelTank = pickSection(root, 'fuel_tank');
  const ps = pickSection(root, 'press_system');
  const fluids = pickSection(root, 'fluids');
  const fuelFluid =
    asRecord(fluids?.fuel)
    ?? (fluids ? asRecord((fluids as Record<string, unknown>)['Fuel']) : undefined);
  const combustion = pickSection(root, 'combustion');

  const fromPressTank = pickNumericFieldLoose(pressTank, ['free_volume_L', 'freeVolumeL']);
  const fromDr = pickNumericFieldLoose(dr, ['copv_free_volume_L', 'copvFreeVolumeL']);
  if (fromPressTank) out.copvVolumeL = fromPressTank;
  else if (fromDr) out.copvVolumeL = fromDr;

  const loxVm3 = pickNumericFieldLoose(loxTank, ['tank_volume_m3', 'tankVolumeM3']);
  if (loxVm3) out.tankVolumeLoxL = String(parseFloat(loxVm3) * 1000);

  const fuelVm3 = pickNumericFieldLoose(fuelTank, ['tank_volume_m3', 'tankVolumeM3']);
  if (fuelVm3) out.tankVolumeFuelL = String(parseFloat(fuelVm3) * 1000);

  const ambT = pickNumericFieldLoose(combustion, ['ambient_temperature', 'ambientTemperature']);
  // Default T COPV to 300 K (ambient) when YAML is silent — press-test rig is almost always room temp.
  out.tCopvK = ambT ?? '300';

  const fuelT = pickNumericFieldLoose(fuelFluid, ['temperature']);
  if (fuelT && parseFloat(fuelT) >= 150) out.tUllK = fuelT;

  if (ps) {
    const rc = pickNumericFieldLoose(ps, ['reg_cv', 'regCv']);
    if (rc) out.regCv = rc;
    const rd = pickNumericFieldLoose(ps, ['reg_droop_coeff', 'regDroopCoeff']);
    if (rd) out.regDroop = rd;
    const rs = pickNumericFieldLoose(ps, ['reg_setpoint_psi', 'regSetpointPsi']);
    if (rs) out.regSetpoint = rs;
    const ri = pickNumericFieldLoose(ps, ['reg_initial_copv_psi', 'regInitialCopvPsi']);
    if (ri) out.regInitialCopv = ri;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Spreadsheet grid
// ---------------------------------------------------------------------------

function SpreadsheetGrid({
  rows,
  onChange,
  chokeDiameterMm,
  waterDensity,
}: {
  rows: RowInput[];
  onChange: (rows: RowInput[]) => void;
  chokeDiameterMm: string;
  waterDensity: string;
}) {
  const [anchor, setAnchor]   = useState<CellPos | null>(null);
  const [active, setActive]   = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [editVal, setEditVal] = useState('');
  const gridRef    = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const isDragging = useRef(false);

  const chokeDiamM = parseFloat(chokeDiameterMm) / 1000;
  const waterRho   = parseFloat(waterDensity) || 998.2;
  const numCols = COLS.length;
  const numRows = rows.length;

  const sel = anchor && active ? {
    r0: Math.min(anchor.row, active.row), r1: Math.max(anchor.row, active.row),
    c0: Math.min(anchor.col, active.col), c1: Math.max(anchor.col, active.col),
  } : null;

  function inSel(r: number, c: number) {
    return !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
  }
  function isActiveCell(r: number, c: number) { return active?.row === r && active?.col === c; }

  function getCellValue(r: number, c: number): string {
    const col = COLS[c];
    const row = rows[r];
    if (!row) return '';
    if (col.kind === 'input') return String(row[col.inputKey] ?? '');
    return col.compute(row, rows[r - 1] ?? null, chokeDiamM, waterRho);
  }

  function setCell(r: number, c: number, v: string) {
    const col = COLS[c];
    if (col.kind !== 'input') return;
    onChange(rows.map((row, i) => i === r ? { ...row, [col.inputKey]: v } : row));
  }

  function moveTo(r: number, c: number, extend = false) {
    r = Math.max(0, Math.min(r, numRows - 1));
    c = Math.max(0, Math.min(c, numCols - 1));
    setActive({ row: r, col: c });
    if (!extend) setAnchor({ row: r, col: c });
    gridRef.current?.focus();
  }

  function tabMoveTo(r: number, c: number, shift: boolean) {
    const pos = INPUT_COL_INDICES.indexOf(c);
    const effectivePos = pos >= 0 ? pos : (shift ? INPUT_COL_INDICES.length - 1 : 0);
    if (!shift && effectivePos === INPUT_COL_INDICES.length - 1) {
      if (r === numRows - 1) {
        const next = [...rows, newRow(numRows + 1)];
        onChange(next);
        setTimeout(() => moveTo(r + 1, FIRST_INPUT), 0);
      } else {
        moveTo(r + 1, FIRST_INPUT);
      }
    } else if (shift && effectivePos === 0) {
      if (r > 0) moveTo(r - 1, LAST_INPUT);
    } else {
      moveTo(r, INPUT_COL_INDICES[effectivePos + (shift ? -1 : 1)]);
    }
  }

  function startEdit(r: number, c: number, initial?: string) {
    if (COLS[c].kind !== 'input') return;
    setEditing({ row: r, col: c });
    setEditVal(initial !== undefined ? initial : getCellValue(r, c));
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }

  function commitEdit() {
    if (!editing) return;
    setCell(editing.row, editing.col, editVal);
    setEditing(null);
  }

  function cancelEdit() { setEditing(null); gridRef.current?.focus(); }

  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!active) return;
    const { row: r, col: c } = active;
    if (editing) return;

    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(r, c); return; }
    if (e.key === 'Tab')       { e.preventDefault(); tabMoveTo(r, c, e.shiftKey); return; }
    if (e.key === 'Escape')    { setAnchor({ row: r, col: c }); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveTo(r - 1, c, e.shiftKey); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(r + 1, c, e.shiftKey); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(r, c - 1, e.shiftKey); return; }
    if (e.key === 'ArrowRight'){ e.preventDefault(); moveTo(r, c + 1, e.shiftKey); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (sel) {
        onChange(rows.map((row, ri) => {
          if (ri < sel.r0 || ri > sel.r1) return row;
          const patch: Partial<RowInput> = {};
          for (let ci = sel.c0; ci <= sel.c1; ci++) {
            const col = COLS[ci];
            if (col.kind === 'input') patch[col.inputKey] = '';
          }
          return { ...row, ...patch };
        }));
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      if (sel) {
        const tsv: string[] = [];
        for (let ri = sel.r0; ri <= sel.r1; ri++)
          tsv.push(Array.from({ length: sel.c1 - sel.c0 + 1 }, (_, ci) => getCellValue(ri, sel.c0 + ci)).join('\t'));
        navigator.clipboard.writeText(tsv.join('\n'));
      }
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && COLS[c].kind === 'input') {
      startEdit(r, c, e.key);
    }
  }

  function handleGridPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (editing || !active) return;
    e.preventDefault();
    const startInputPos = INPUT_COL_INDICES.indexOf(active.col);
    if (startInputPos === -1) return;

    const text = e.clipboardData.getData('text');
    const pastedRows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
      .split('\n').map(r => r.split('\t'));

    const next = rows.map(r => ({ ...r }));
    pastedRows.forEach((pr, ri) => {
      const ti = active.row + ri;
      while (next.length <= ti) next.push(newRow(next.length + 1));
      pr.forEach((val, ci) => {
        const inputIdx = startInputPos + ci;
        if (inputIdx < INPUT_COL_INDICES.length) {
          const col = COLS[INPUT_COL_INDICES[inputIdx]] as InputCol;
          next[ti] = { ...next[ti], [col.inputKey]: val.trim() };
        }
      });
    });
    onChange(next);
  }

  function handleCellMouseDown(e: React.MouseEvent, r: number, c: number) {
    if (editing) commitEdit();
    if (e.shiftKey && anchor) { setActive({ row: r, col: c }); }
    else { setAnchor({ row: r, col: c }); setActive({ row: r, col: c }); }
    isDragging.current = true;
    gridRef.current?.focus();
  }

  function handleCellMouseEnter(r: number, c: number) {
    if (isDragging.current) setActive({ row: r, col: c });
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!editing) return;
    const { row: r, col: c } = editing;
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); moveTo(r + 1, c); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Tab')    { e.preventDefault(); commitEdit(); tabMoveTo(r, c, e.shiftKey); }
    else if (e.key === 'ArrowUp' && (e.target as HTMLInputElement).selectionStart === 0) {
      e.preventDefault(); commitEdit(); moveTo(r - 1, c);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); commitEdit(); moveTo(r + 1, c);
    }
  }

  const borderColor  = 'rgba(255,255,255,0.1)';
  const headerBg     = 'rgba(255,255,255,0.05)';
  const computedBg   = 'rgba(255,255,255,0.02)';
  const selBg        = 'rgba(59,130,246,0.18)';
  const activeBorder = '2px solid #3b82f6';
  const rowNumBg     = 'rgba(255,255,255,0.03)';

  const cellBase: React.CSSProperties = {
    border: `1px solid ${borderColor}`,
    padding: 0,
    position: 'relative',
    height: 26,
    verticalAlign: 'middle',
    cursor: 'default',
  };

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      onKeyDown={handleGridKeyDown}
      onPaste={handleGridPaste}
      onMouseUp={() => { isDragging.current = false; }}
      onMouseLeave={() => { isDragging.current = false; }}
      className="outline-none"
      style={{ userSelect: 'none', overflowX: 'auto' }}
    >
      <table style={{ borderCollapse: 'collapse', fontSize: 13, fontFamily: 'ui-monospace, monospace', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 36 }} />
          {COLS.map(c => <col key={c.key} style={{ width: c.width }} />)}
          <col style={{ width: 28 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...cellBase, background: headerBg }} />
            {COLS.map(col => (
              <th key={col.key} style={{
                ...cellBase,
                background: col.kind === 'computed' ? computedBg : headerBg,
                padding: '0 6px',
                textAlign: 'left',
                fontSize: 11,
                fontWeight: 600,
                color: col.kind === 'computed' ? 'rgba(255,255,255,0.3)' : 'var(--color-text-secondary)',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                fontStyle: col.kind === 'computed' ? 'italic' : undefined,
              }}>
                {col.header}
              </th>
            ))}
            <th style={{ ...cellBase, background: headerBg }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id}>
              <td style={{ ...cellBase, background: rowNumBg, textAlign: 'center', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {ri + 1}
              </td>

              {COLS.map((col, ci) => {
                const isEditingThis = editing?.row === ri && editing?.col === ci;
                const selected      = inSel(ri, ci);
                const isActive      = isActiveCell(ri, ci);
                const isComputed    = col.kind === 'computed';
                const displayVal    = getCellValue(ri, ci);
                const hlState       = isComputed && col.highlight ? col.highlight(displayVal) : null;

                return (
                  <td
                    key={col.key}
                    onMouseDown={e => handleCellMouseDown(e, ri, ci)}
                    onMouseEnter={() => handleCellMouseEnter(ri, ci)}
                    onDoubleClick={() => startEdit(ri, ci)}
                    style={{
                      ...cellBase,
                      background: selected ? selBg
                            : hlState === 'good' ? 'rgba(34,197,94,0.12)'
                            : hlState === 'warn' ? 'rgba(239,68,68,0.12)'
                            : isComputed ? computedBg : 'var(--color-bg-primary)',
                      outline: isActive && !isEditingThis ? activeBorder : undefined,
                      outlineOffset: '-2px',
                      overflow: 'hidden',
                    }}
                  >
                    {isEditingThis ? (
                      <input
                        ref={inputRef}
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={handleInputKeyDown}
                        style={{
                          width: '100%', height: '100%',
                          border: activeBorder, outline: 'none',
                          background: 'var(--color-bg-primary)',
                          color: 'var(--color-text-primary)',
                          padding: '1px 5px',
                          fontFamily: 'inherit', fontSize: 'inherit',
                          boxSizing: 'border-box',
                          position: 'absolute', top: 0, left: 0, zIndex: 2,
                        }}
                      />
                    ) : (
                      <div style={{
                        padding: '1px 5px',
                        color: hlState === 'good' ? '#4ade80'
                          : hlState === 'warn' ? '#f87171'
                          : isComputed
                            ? (displayVal === '—' ? 'rgba(255,255,255,0.2)' : '#f59e0b')
                            : 'var(--color-text-primary)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {displayVal}
                      </div>
                    )}
                  </td>
                );
              })}

              <td style={{ ...cellBase, background: rowNumBg, textAlign: 'center' }}>
                {rows.length > 1 && (
                  <button
                    tabIndex={-1}
                    onMouseDown={e => { e.stopPropagation(); onChange(rows.filter((_, idx) => idx !== ri)); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 12, padding: '0 4px' }}
                  >×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid panel (grid + header + add/copy buttons)
// ---------------------------------------------------------------------------

function GridPanel({
  title,
  accentColor,
  rows,
  onChange,
  waterDensity,
}: {
  title: string;
  accentColor: string;
  rows: RowInput[];
  onChange: (rows: RowInput[]) => void;
  waterDensity: string;
}) {
  const waterRho = parseFloat(waterDensity) || 998.2;

  function copyAll() {
    const header = COLS.map(c => c.header).join('\t');
    const computedCols = COLS.filter((c): c is ComputedCol => c.kind === 'computed');
    const body = rows.map((r, i) => {
      const prev = rows[i - 1] ?? null;
      return INPUT_COLS.map(c => r[c.inputKey]).join('\t')
        + '\t' + computedCols.map(c => c.compute(r, prev, 0, waterRho)).join('\t');
    }).join('\n');
    navigator.clipboard.writeText(header + '\n' + body);
  }

  const inputCls = "w-full px-2 py-1.5 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none";

  return (
    <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-3 min-w-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: accentColor }}>{title}</h3>
        <div className="flex gap-2">
          <button
            onClick={() => onChange([...rows, newRow(rows.length + 1)])}
            className="px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors"
            style={{ borderColor: `${accentColor}40`, color: accentColor, background: `${accentColor}10` }}
          >
            + Add Row
          </button>
          <button
            onClick={copyAll}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Copy All
          </button>
        </div>
      </div>

      <SpreadsheetGrid rows={rows} onChange={onChange} chokeDiameterMm="0" waterDensity={waterDensity} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Press-feed spreadsheet grid
// ---------------------------------------------------------------------------

type PressPos = { row: number; col: number };

type PressColKey =
  | 'tank'
  | 'ullageFraction'
  | 'copvPStart'
  | 'copvPEnd'
  | 'copvTStart'
  | 'copvTEnd'
  | 'tankPStart'
  | 'tankPEnd'
  | 'tankTStart'
  | 'tankTEnd';

const PRESS_COLS: { key: PressColKey; header: string; width: number; kind: 'text' | 'number' }[] = [
  { key: 'tank',          header: 'Tank',               width: 120, kind: 'text'   },
  { key: 'ullageFraction',header: 'Ullage frac [0–1]',  width: 120, kind: 'number' },
  { key: 'copvPStart',    header: 'COPV P₀ [psi]',      width: 108, kind: 'number' },
  { key: 'copvPEnd',      header: 'COPV Pf [psi]',      width: 108, kind: 'number' },
  { key: 'copvTStart',    header: 'COPV t₀ [s]',        width: 90,  kind: 'number' },
  { key: 'copvTEnd',      header: 'COPV tf [s]',        width: 90,  kind: 'number' },
  { key: 'tankPStart',    header: 'Tank P₀ [psi]',      width: 108, kind: 'number' },
  { key: 'tankPEnd',      header: 'Tank Pf [psi]',      width: 108, kind: 'number' },
  { key: 'tankTStart',    header: 'Tank t₀ [s]',        width: 90,  kind: 'number' },
  { key: 'tankTEnd',      header: 'Tank tf [s]',        width: 90,  kind: 'number' },
] as const;

function PressSpreadsheetGrid({
  rows,
  onChange,
}: {
  rows: PressTestRowInput[];
  onChange: (rows: PressTestRowInput[]) => void;
}) {
  const [anchor, setAnchor] = useState<PressPos | null>(null);
  const [active, setActive] = useState<PressPos | null>(null);
  const [editing, setEditing] = useState<PressPos | null>(null);
  const [editVal, setEditVal] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDragging = useRef(false);

  const numCols = PRESS_COLS.length;
  const numRows = rows.length;

  const sel = anchor && active ? {
    r0: Math.min(anchor.row, active.row), r1: Math.max(anchor.row, active.row),
    c0: Math.min(anchor.col, active.col), c1: Math.max(anchor.col, active.col),
  } : null;

  function inSel(r: number, c: number) {
    return !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
  }

  function normalizeTank(v: string): 'lox' | 'fuel' | null {
    const s = (v ?? '').trim().toLowerCase();
    if (s === 'lox' || s === 'o' || s === 'ox' || s === 'oxidizer') return 'lox';
    if (s === 'fuel' || s === 'f' || s === 'rp1' || s === 'rp-1') return 'fuel';
    return null;
  }

  function updateRowByIndex(ri: number, key: PressColKey, val: string) {
    if (key === 'tank') {
      const t = normalizeTank(val);
      // Only accept valid tank values; otherwise ignore.
      if (!t) return;
      onChange(rows.map((r, i) => i === ri ? { ...r, tank: t } : r));
      return;
    }
    onChange(rows.map((r, i) => i === ri ? { ...r, [key]: val } : r));
  }

  function removeRow(ri: number) {
    if (rows.length <= 1) return;
    onChange(rows.filter((_, i) => i !== ri));
    setAnchor(null);
    setActive(null);
    setEditing(null);
  }

  function addRow() {
    onChange([...rows, newPressRow(rows.length + 1)]);
  }

  function getCellValue(r: number, c: number): string {
    const col = PRESS_COLS[c];
    const row = rows[r];
    if (!row) return '';
    if (col.key === 'tank') return row.tank === 'lox' ? 'LOX' : 'FUEL';
    return String((row as any)[col.key] ?? '');
  }

  function setCell(r: number, c: number, v: string) {
    const col = PRESS_COLS[c];
    updateRowByIndex(r, col.key, v);
  }

  function moveTo(r: number, c: number, extend = false) {
    r = Math.max(0, Math.min(r, numRows - 1));
    c = Math.max(0, Math.min(c, numCols - 1));
    setActive({ row: r, col: c });
    if (!extend) setAnchor({ row: r, col: c });
    gridRef.current?.focus();
  }

  function startEdit(r: number, c: number, initial?: string) {
    setEditing({ row: r, col: c });
    setEditVal(initial !== undefined ? initial : getCellValue(r, c));
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }

  function commitEdit() {
    if (!editing) return;
    setCell(editing.row, editing.col, editVal);
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
    gridRef.current?.focus();
  }

  function clearSelection() {
    if (!sel) return;
    onChange(rows.map((row, ri) => {
      if (ri < sel.r0 || ri > sel.r1) return row;
      const patch: Partial<PressTestRowInput> = {};
      for (let ci = sel.c0; ci <= sel.c1; ci++) {
        const key = PRESS_COLS[ci].key;
        if (key === 'tank') continue; // keep tank valid; user can paste over it
        (patch as any)[key] = '';
      }
      return { ...row, ...patch };
    }));
  }

  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!active) return;
    if (editing) return;
    const { row: r, col: c } = active;

    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(r, c); return; }
    if (e.key === 'Escape') { setAnchor({ row: r, col: c }); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const dc = e.shiftKey ? -1 : 1;
      let nr = r;
      let nc = c + dc;
      if (nc >= numCols) { nc = 0; nr = Math.min(numRows - 1, r + 1); }
      if (nc < 0) { nc = numCols - 1; nr = Math.max(0, r - 1); }
      moveTo(nr, nc);
      return;
    }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveTo(r - 1, c, e.shiftKey); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(r + 1, c, e.shiftKey); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(r, c - 1, e.shiftKey); return; }
    if (e.key === 'ArrowRight'){ e.preventDefault(); moveTo(r, c + 1, e.shiftKey); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelection(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      if (!sel) return;
      const tsv: string[] = [];
      for (let ri = sel.r0; ri <= sel.r1; ri++) {
        const rowVals: string[] = [];
        for (let ci = sel.c0; ci <= sel.c1; ci++) rowVals.push(getCellValue(ri, ci));
        tsv.push(rowVals.join('\t'));
      }
      navigator.clipboard.writeText(tsv.join('\n'));
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      startEdit(r, c, e.key);
    }
  }

  function applyPastedValueToPressCell(row: PressTestRowInput, key: PressColKey, val: string): PressTestRowInput {
    if (key === 'tank') {
      const t = normalizeTank(val);
      return t ? { ...row, tank: t } : row;
    }
    const st = stripCsvQuotes(val);
    if (key === 'ullageFraction') {
      const n = parseUsFloat(st);
      return Number.isFinite(n) ? { ...row, ullageFraction: String(n) } : { ...row, ullageFraction: st };
    }
    if (key === 'copvPStart' || key === 'copvPEnd' || key === 'tankPStart' || key === 'tankPEnd') {
      return { ...row, [key]: parseUsNumberString(st) };
    }
    // time columns: absolute datetimes → epoch seconds (s); plain numbers unchanged
    if (isLikelyAbsoluteDatetime(st)) {
      const ms = Date.parse(st.replace(' ', 'T'));
      if (Number.isFinite(ms)) {
        return { ...row, [key]: (ms / 1000).toFixed(6) };
      }
    }
    return { ...row, [key]: parseUsNumberString(st) };
  }

  function handleGridPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!active || editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/^\uFEFF/, '');
    let lineStrs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n').filter((ln) => ln.length > 0);
    let pastedRows = lineStrs.map((r) => splitClipboardRow(r));
    if (pastedRows.length && isPressFeedHeaderRow(pastedRows[0])) {
      pastedRows = pastedRows.slice(1);
    }

    const next = rows.map((r) => ({ ...r }));
    pastedRows.forEach((cells, ri) => {
      const tr = active.row + ri;
      while (next.length <= tr) next.push(newPressRow(next.length + 1));

      // Full-row CSV / Excel export (10 columns from Tank) — datetimes + thousands separators
      if (active.col === 0 && cells.length >= 10) {
        const tank = normalizeTank(cells[0]);
        if (!tank) return;
        const [ct0, ctf, tt0, ttf] = convertPressFourTimes(cells[4], cells[5], cells[8], cells[9]);
        const prev = next[tr];
        next[tr] = {
          ...prev,
          tank,
          ullageFraction: (() => {
            const canon = parseUsNumberString(stripCsvQuotes(cells[1]));
            const n = parseFloat(canon);
            return Number.isFinite(n) ? canon : prev.ullageFraction;
          })(),
          copvPStart: parseUsNumberString(stripCsvQuotes(cells[2])),
          copvPEnd: parseUsNumberString(stripCsvQuotes(cells[3])),
          copvTStart: ct0,
          copvTEnd: ctf,
          tankPStart: parseUsNumberString(stripCsvQuotes(cells[6])),
          tankPEnd: parseUsNumberString(stripCsvQuotes(cells[7])),
          tankTStart: tt0,
          tankTEnd: ttf,
        };
        return;
      }

      cells.forEach((val, ci) => {
        const tc = active.col + ci;
        if (tc < 0 || tc >= numCols) return;
        const key = PRESS_COLS[tc].key;
        next[tr] = applyPastedValueToPressCell(next[tr], key, val);
      });
    });
    onChange(next);
  }

  function handleCellMouseDown(e: React.MouseEvent, r: number, c: number) {
    if (editing) commitEdit();
    if (e.shiftKey && anchor) setActive({ row: r, col: c });
    else { setAnchor({ row: r, col: c }); setActive({ row: r, col: c }); }
    isDragging.current = true;
    gridRef.current?.focus();
  }

  function handleCellMouseEnter(r: number, c: number) {
    if (isDragging.current) setActive({ row: r, col: c });
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!editing) return;
    const { row: r, col: c } = editing;
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); moveTo(Math.min(numRows - 1, r + 1), c); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      const dc = e.shiftKey ? -1 : 1;
      let nr = r;
      let nc = c + dc;
      if (nc >= numCols) { nc = 0; nr = Math.min(numRows - 1, r + 1); }
      if (nc < 0) { nc = numCols - 1; nr = Math.max(0, r - 1); }
      moveTo(nr, nc);
    }
  }

  const borderColor = 'rgba(255,255,255,0.1)';
  const headerBg = 'rgba(255,255,255,0.05)';
  const selBg = 'rgba(59,130,246,0.18)';
  const activeBorder = '2px solid #3b82f6';
  const rowNumBg = 'rgba(255,255,255,0.03)';
  const cellBase: React.CSSProperties = {
    border: `1px solid ${borderColor}`,
    padding: 0,
    position: 'relative',
    height: 28,
    verticalAlign: 'middle',
    cursor: 'default',
  };

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      onKeyDown={handleGridKeyDown}
      onPaste={handleGridPaste}
      onMouseUp={() => { isDragging.current = false; }}
      onMouseLeave={() => { isDragging.current = false; }}
      className="outline-none"
      style={{ userSelect: 'none', overflowX: 'auto' }}
    >
      <table style={{ borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 36 }} />
          {PRESS_COLS.map(c => <col key={c.key} style={{ width: c.width }} />)}
          <col style={{ width: 80 }} />
          <col style={{ width: 80 }} />
          <col style={{ width: 32 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...cellBase, background: headerBg }} />
            {PRESS_COLS.map(col => (
              <th key={col.key} style={{ ...cellBase, background: headerBg, padding: '0 8px', textAlign: 'left', color: 'var(--color-text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                {col.header}
              </th>
            ))}
            <th style={{ ...cellBase, background: headerBg, padding: '0 8px', color: 'var(--color-text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>COPV ΔP</th>
            <th style={{ ...cellBase, background: headerBg, padding: '0 8px', color: 'var(--color-text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>Tank ΔP</th>
            <th style={{ ...cellBase, background: headerBg }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const copvDp = parseUsFloat(row.copvPStart) - parseUsFloat(row.copvPEnd);
            const tankDp = parseUsFloat(row.tankPEnd) - parseUsFloat(row.tankPStart);

            return (
              <tr key={row.id}>
                {/* Row number */}
                <td style={{ ...cellBase, background: rowNumBg, textAlign: 'center', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {ri + 1}
                </td>

                {/* Editable cells */}
                {PRESS_COLS.map((col, ci) => {
                  const isEditingThis = editing?.row === ri && editing?.col === ci;
                  const selected = inSel(ri, ci);
                  const isActive = active?.row === ri && active?.col === ci;
                  const displayVal = getCellValue(ri, ci);
                  return (
                    <td
                      key={col.key}
                      onMouseDown={e => handleCellMouseDown(e, ri, ci)}
                      onMouseEnter={() => handleCellMouseEnter(ri, ci)}
                      onDoubleClick={() => startEdit(ri, ci)}
                      style={{
                        ...cellBase,
                        background: selected ? selBg : 'var(--color-bg-primary)',
                        outline: isActive && !isEditingThis ? activeBorder : undefined,
                        outlineOffset: '-2px',
                        overflow: 'hidden',
                      }}
                    >
                      {isEditingThis ? (
                        <input
                          ref={inputRef}
                          value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={handleInputKeyDown}
                          type={col.kind === 'number' ? 'number' : 'text'}
                          step={col.kind === 'number' ? 'any' : undefined}
                          style={{
                            width: '100%',
                            height: '100%',
                            border: activeBorder,
                            outline: 'none',
                            background: 'var(--color-bg-primary)',
                            color: 'var(--color-text-primary)',
                            padding: '2px 6px',
                            fontFamily: 'ui-monospace, monospace',
                            fontSize: 12,
                            boxSizing: 'border-box',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            zIndex: 2,
                          }}
                        />
                      ) : (
                        <div style={{
                          padding: '2px 6px',
                          fontFamily: 'ui-monospace, monospace',
                          fontSize: 12,
                          color: displayVal ? 'var(--color-text-primary)' : 'rgba(255,255,255,0.2)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {displayVal || '—'}
                        </div>
                      )}
                    </td>
                  );
                })}

                {/* Computed: COPV ΔP */}
                <td style={{ ...cellBase, padding: '0 8px', fontFamily: 'ui-monospace, monospace', color: Number.isFinite(copvDp) && copvDp > 0 ? '#f97316' : 'rgba(255,255,255,0.2)' }}>
                  {Number.isFinite(copvDp) && copvDp > 0 ? copvDp.toFixed(1) : '—'}
                </td>
                {/* Computed: Tank ΔP */}
                <td style={{ ...cellBase, padding: '0 8px', fontFamily: 'ui-monospace, monospace', color: Number.isFinite(tankDp) && tankDp > 0 ? '#60a5fa' : 'rgba(255,255,255,0.2)' }}>
                  {Number.isFinite(tankDp) && tankDp > 0 ? tankDp.toFixed(1) : '—'}
                </td>

                {/* Delete row */}
                <td style={{ ...cellBase, background: rowNumBg, textAlign: 'center' }}>
                  {rows.length > 1 && (
                    <button
                      tabIndex={-1}
                      onMouseDown={e => { e.stopPropagation(); }}
                      onClick={() => removeRow(ri)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 14 }}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-3">
        <button
          onClick={addRow}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          + Add Run
        </button>
      </div>
    </div>
  );
}

function SysField({
  label,
  value,
  onChange,
  missingHint,
  inputCls,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  missingHint: string | null;
  inputCls: string;
}) {
  const empty = value === '';
  return (
    <div>
      <label className="block text-xs text-[var(--color-text-secondary)] mb-1">{label}</label>
      <input
        type="number"
        step="any"
        min="0"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={inputCls}
      />
      {empty && missingHint && (
        <p className="mt-1 text-[10px] text-amber-400/80 font-mono">missing: {missingHint}</p>
      )}
    </div>
  );
}

function PressureFeedExperiment({
  config,
  onConfigUpdated,
}: {
  config: EngineConfig | null;
  onConfigUpdated?: (config: EngineConfig) => void;
}) {
  const [rows, setRows] = useState<PressTestRowInput[]>([newPressRow(1, 'lox'), newPressRow(2, 'fuel')]);

  // System params: one object so YAML → UI sync is atomic (reg setpoint / reg initial COPV cannot drift apart).
  // No fallback defaults — every field comes directly from the loaded config. Missing keys stay empty.
  const pressSyncKey = useMemo(() => pressFeedConfigSyncKey(config), [config]);
  const fromConfig = useMemo(() => pressFeedSystemParamsFromConfig(config), [pressSyncKey]);
  const [sys, setSys] = useState<PressFeedParamStrings>(() => pressFeedSystemParamsFromConfig(config));

  useLayoutEffect(() => {
    setSys(fromConfig);
  }, [fromConfig]);

  const [reloadStatus, setReloadStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reloadError, setReloadError] = useState<string | null>(null);

  async function resyncFromConfig() {
    // Ask the backend to re-read the YAML from disk so hand-edits (outside the UI)
    // are picked up. Then propagate the fresh config up to App.tsx so every tab sees it.
    setReloadStatus('loading');
    setReloadError(null);
    try {
      const resp = await fetch(`${API_BASE}/config/reload`, { method: 'POST' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const body = await resp.json();
      if (body?.config) {
        onConfigUpdated?.(body.config);
        // Fallback in case parent doesn't re-mount / re-render us with the new config.
        setSys(pressFeedSystemParamsFromConfig(body.config));
      } else {
        setSys(pressFeedSystemParamsFromConfig(config));
      }
      setReloadStatus('idle');
    } catch (e) {
      setReloadStatus('error');
      setReloadError(e instanceof Error ? e.message : 'Reload failed');
      setTimeout(() => { setReloadStatus('idle'); setReloadError(null); }, 4000);
    }
  }

  const rawRegInitialFromConfig = (() => {
    const ps = config ? pickSection(config as Record<string, unknown>, 'press_system') : undefined;
    return ps?.['reg_initial_copv_psi'];
  })();

  // Results
  const [results, setResults] = useState<PressTestFitResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const inputCls = "w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none";

  async function handleFit() {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const parsedRows = rows.map((r, i) => ({
        label: `Row ${i + 1}`,
        tank: r.tank,
        ullage_fraction: parseUsFloat(r.ullageFraction),
        copv_p_start_psi: parseUsFloat(r.copvPStart),
        copv_p_end_psi: parseUsFloat(r.copvPEnd),
        copv_t_start_s: parseUsFloat(r.copvTStart),
        copv_t_end_s: parseUsFloat(r.copvTEnd),
        tank_p_start_psi: parseUsFloat(r.tankPStart),
        tank_p_end_psi: parseUsFloat(r.tankPEnd),
        tank_t_start_s: parseUsFloat(r.tankTStart),
        tank_t_end_s: parseUsFloat(r.tankTEnd),
      }));

      for (const r of parsedRows) {
        const nums = Object.entries(r)
          .filter(([k]) => k !== 'tank' && k !== 'ullage_fraction' && k !== 'label')
          .map(([, v]) => v as number);
        if (nums.some(v => Number.isNaN(v))) {
          throw new Error(`All numeric fields must be filled in.`);
        }
        if (r.tank !== 'lox' && r.tank !== 'fuel') {
          throw new Error(`Tank must be LOX or FUEL for every row.`);
        }
        if (Number.isNaN(r.ullage_fraction) || r.ullage_fraction < 0 || r.ullage_fraction > 1) {
          throw new Error(`Ullage fraction must be between 0 and 1.`);
        }
      }

      const resp = await fetch(`${API_BASE}/experiment/press_test_fit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: parsedRows,
          tank_volume_lox_m3: parseFloat(sys.tankVolumeLoxL) / 1000,
          tank_volume_fuel_m3: parseFloat(sys.tankVolumeFuelL) / 1000,
          copv_volume_L: parseFloat(sys.copvVolumeL),
          T_copv_K: parseFloat(sys.tCopvK),
          T_ull_K: parseFloat(sys.tUllK),
          reg_cv: parseFloat(sys.regCv),
          reg_droop_coeff: parseFloat(sys.regDroop),
          reg_setpoint_psi: parseFloat(sys.regSetpoint),
          reg_initial_copv_psi: parseFloat(sys.regInitialCopv),
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      setResults(await resp.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fit failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!results) return;
    setSaveStatus('saving');
    try {
      const body: Record<string, number> = {};
      if (results.cv_line_lox_fitted != null) body.cv_line_lox = results.cv_line_lox_fitted;
      if (results.cv_line_fuel_fitted != null) body.cv_line_fuel = results.cv_line_fuel_fitted;
      const resp = await fetch(`${API_BASE}/experiment/press_test_save_cv_line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      setSaveStatus('saved');
      const res = await getConfig();
      if (res.data?.config) onConfigUpdated?.(res.data.config);
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  }

  return (
    <div className="space-y-5">
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-1">Pressure Feed Experiment</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Fit downstream <span className="font-mono">Cv_line</span> separately for LOX and fuel branches from static press tests (COPV → reg → solenoid → tank, no propellant flow). Tag each run with the tank it pressurizes. COPV and tank time windows do not need to overlap—the fit spans their union and clamps each trace outside its interval (line / solenoid delay is ok).
        </p>
      </div>

      {/* System params */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">System Parameters</h3>
        {!config && (
          <p className="text-xs text-amber-400 mb-3">No engine config loaded — all fields are empty. Load a YAML with <span className="font-mono">press_system</span>, <span className="font-mono">press_tank</span> / <span className="font-mono">design_requirements</span>, and tank volumes to populate these.</p>
        )}
        {config && (
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs text-[var(--color-text-secondary)]">
              Fields pulled directly from active config. Empty = missing from YAML. Edits are one-off and don't save back.{' '}
              <span className="font-mono text-[var(--color-text-primary)]">
                press_system.reg_initial_copv_psi = {rawRegInitialFromConfig === undefined ? <span className="text-amber-400">undefined</span> : String(rawRegInitialFromConfig)}
              </span>
            </p>
            <button
              type="button"
              onClick={resyncFromConfig}
              disabled={reloadStatus === 'loading'}
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors whitespace-nowrap disabled:opacity-50"
              title="Re-read YAML from disk on the backend and repopulate every field"
            >
              {reloadStatus === 'loading' ? 'Reloading…' : reloadStatus === 'error' ? 'Reload failed' : 'Reload from Config (disk)'}
            </button>
          </div>
        )}
        {reloadError && (
          <p className="text-xs text-red-400 mb-3">Reload error: {reloadError}</p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <SysField label="COPV Volume [L]"        value={sys.copvVolumeL}     onChange={v => setSys(s => ({ ...s, copvVolumeL: v }))}     missingHint={config ? 'press_tank.free_volume_L' : null} inputCls={inputCls} />
          <SysField label="LOX Tank Volume [L]"    value={sys.tankVolumeLoxL}  onChange={v => setSys(s => ({ ...s, tankVolumeLoxL: v }))}  missingHint={config ? 'lox_tank.tank_volume_m3' : null} inputCls={inputCls} />
          <SysField label="Fuel Tank Volume [L]"   value={sys.tankVolumeFuelL} onChange={v => setSys(s => ({ ...s, tankVolumeFuelL: v }))} missingHint={config ? 'fuel_tank.tank_volume_m3' : null} inputCls={inputCls} />
          <SysField label="T COPV [K]"             value={sys.tCopvK}          onChange={v => setSys(s => ({ ...s, tCopvK: v }))}          missingHint={config ? 'combustion.ambient_temperature' : null} inputCls={inputCls} />
          <SysField label="T Ullage [K]"           value={sys.tUllK}           onChange={v => setSys(s => ({ ...s, tUllK: v }))}           missingHint={config ? 'fluids.fuel.temperature (≥150K)' : null} inputCls={inputCls} />
          <SysField label="Reg Cv"                 value={sys.regCv}           onChange={v => setSys(s => ({ ...s, regCv: v }))}           missingHint={config ? 'press_system.reg_cv' : null} inputCls={inputCls} />
          <SysField label="Reg Droop (psi/psi)"    value={sys.regDroop}        onChange={v => setSys(s => ({ ...s, regDroop: v }))}        missingHint={config ? 'press_system.reg_droop_coeff' : null} inputCls={inputCls} />
          <SysField label="Reg Setpoint [psi]"     value={sys.regSetpoint}     onChange={v => setSys(s => ({ ...s, regSetpoint: v }))}     missingHint={config ? 'press_system.reg_setpoint_psi' : null} inputCls={inputCls} />
          <SysField label="Reg Initial COPV [psi]" value={sys.regInitialCopv}  onChange={v => setSys(s => ({ ...s, regInitialCopv: v }))}  missingHint={config ? 'press_system.reg_initial_copv_psi' : null} inputCls={inputCls} />
        </div>
      </div>

      {/* Spreadsheet */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">Static Test Runs</h3>
        <PressSpreadsheetGrid rows={rows} onChange={setRows} />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        <button
          onClick={handleFit}
          disabled={loading}
          className="px-4 py-2 rounded-xl font-semibold text-sm transition-colors bg-blue-500 hover:bg-blue-400 text-black disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Fitting…' : 'Fit Cv_line'}
        </button>
        {results?.save_available && (results.cv_line_lox_fitted != null || results.cv_line_fuel_fitted != null) && (
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="px-4 py-2 rounded-xl font-semibold text-sm transition-colors bg-emerald-500 hover:bg-emerald-400 text-black disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : saveStatus === 'error' ? 'Save failed' : 'Save Cv_lines to Config'}
          </button>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-4">
          {/* Branch fit summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* LOX */}
            <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-blue-500/30">
              <div className="flex items-center gap-2 mb-3">
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#60a5fa', display: 'inline-block' }} />
                <h3 className="text-sm font-semibold text-blue-400 uppercase tracking-wider">LOX Branch</h3>
              </div>
              {results.cv_line_lox_fitted != null ? (
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_line_lox</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">
                      {results.cv_line_lox_fitted.toFixed(6)}
                      <span className="text-[var(--color-text-secondary)]"> ± {results.cv_line_lox_std?.toFixed(6)}</span>
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_reg</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">{results.cv_reg.toFixed(4)}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_eff</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">{results.cv_eff_lox?.toFixed(6)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-secondary)] italic">No LOX runs provided.</p>
              )}
            </div>
            {/* Fuel */}
            <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-orange-500/30">
              <div className="flex items-center gap-2 mb-3">
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} />
                <h3 className="text-sm font-semibold text-orange-400 uppercase tracking-wider">Fuel Branch</h3>
              </div>
              {results.cv_line_fuel_fitted != null ? (
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_line_fuel</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">
                      {results.cv_line_fuel_fitted.toFixed(6)}
                      <span className="text-[var(--color-text-secondary)]"> ± {results.cv_line_fuel_std?.toFixed(6)}</span>
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_reg</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">{results.cv_reg.toFixed(4)}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Cv_eff</p>
                    <p className="font-mono text-[var(--color-text-primary)] text-xs">{results.cv_eff_fuel?.toFixed(6)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-secondary)] italic">No Fuel runs provided.</p>
              )}
            </div>
          </div>

          <p className="text-xs text-[var(--color-text-secondary)] px-1">{results.recommendation}</p>

          {/* Every submitted row: ok vs skipped + reason */}
          {(results.row_diagnostics ?? []).length > 0 && (
            <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-x-auto">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">Row status (all submitted)</h3>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['#', 'Tank', 'Label', 'Status', 'Note'].map(h => (
                      <th key={h} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(results.row_diagnostics ?? []).map((d) => {
                    const tankColor = d.tank === 'lox' ? '#60a5fa' : '#f97316';
                    const ok = d.status === 'ok';
                    return (
                      <tr key={d.row_index} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace', color: 'var(--color-text-secondary)' }}>{d.row_index + 1}</td>
                        <td style={{ padding: '4px 8px' }}>
                          <span style={{ color: tankColor, fontWeight: 700, fontSize: 10, letterSpacing: '0.04em' }}>
                            {d.tank === 'lox' ? 'LOX' : 'FUEL'}
                          </span>
                        </td>
                        <td style={{ padding: '4px 8px' }}>{d.label}</td>
                        <td style={{ padding: '4px 8px', color: ok ? '#34d399' : '#f59e0b', fontWeight: 600 }}>{ok ? 'OK' : 'Skipped'}</td>
                        <td style={{ padding: '4px 8px', color: ok ? 'var(--color-text-secondary)' : '#fdba74', maxWidth: 520 }}>
                          {ok ? '—' : d.message}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-run diagnostics */}
          <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-x-auto">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">Per-run Diagnostics (used in fit)</h3>
            {results.rows.length === 0 ? (
              <p className="text-xs text-[var(--color-text-secondary)] italic">No rows produced a Cv_line estimate.</p>
            ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  {['#', 'Tank', 'Label', 'Cv_line', 'COPV ΔP [psi]', 'Tank ΔP [psi]', 'ṁ COPV [g/s]', 'ṁ Tank [g/s]', 'Cross-check'].map(h => (
                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.rows.map((r, i) => {
                  const ratioOk = Math.abs(r.cross_check_ratio - 1.0) < 0.10;
                  const tankColor = r.tank === 'lox' ? '#60a5fa' : '#f97316';
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace', color: 'var(--color-text-secondary)' }}>{r.row_index + 1}</td>
                      <td style={{ padding: '4px 8px' }}>
                        <span style={{ color: tankColor, fontWeight: 700, fontSize: 10, letterSpacing: '0.04em' }}>
                          {r.tank === 'lox' ? 'LOX' : 'FUEL'}
                        </span>
                      </td>
                      <td style={{ padding: '4px 8px' }}>{r.label}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}>{r.cv_line_estimate.toFixed(6)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}>{r.copv_dp_psi.toFixed(1)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}>{r.tank_dp_psi.toFixed(1)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}>{(r.mdot_copv_avg * 1000).toFixed(2)}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace' }}>{(r.mdot_tank_avg * 1000).toFixed(2)}</td>
                      <td style={{ padding: '4px 8px', color: ratioOk ? '#34d399' : '#f59e0b', fontFamily: 'ui-monospace, monospace' }}>
                        {r.cross_check_ratio.toFixed(3)} {ratioOk ? '✓' : '⚠'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ExperimentMode({ config, onConfigUpdated }: ExperimentModeProps) {
  const [activeTab, setActiveTab] = useState<ExperimentTab>('cold_flow');

  const [waterDensity, setWaterDensity] = useState('998.2');
  const [fuelRows, setFuelRows] = useState<RowInput[]>([
    { id: 1, label: 'Run 1', t0: '', tf: '', deltaP: '', weight: '' },
  ]);
  const [loxRows, setLoxRows] = useState<RowInput[]>([
    { id: 2, label: 'Run 1', t0: '', tf: '', deltaP: '', weight: '' },
  ]);
  const [results,  setResults]  = useState<TimeseriesResponse | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const inputCls = "w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-amber-500";

  async function handleCalculate() {
    setError(null);
    setResults(null);

    function buildRows(rows: RowInput[], label: string) {
      const parsed = rows.map((r, i) => ({
        label: r.label || `Run ${i + 1}`,
        t0: parseFloat(r.t0),
        tf: parseFloat(r.tf),
        delta_p_psi: parseFloat(r.deltaP),
        weight: parseFloat(r.weight),
      }));
      for (const r of parsed) {
        if (isNaN(r.t0) || isNaN(r.tf) || isNaN(r.delta_p_psi) || isNaN(r.weight)) {
          setError(`${label} row "${r.label}": all fields must be filled in.`);
          return null;
        }
      }
      return parsed;
    }

    const parsedFuel = buildRows(fuelRows, 'Fuel');
    if (!parsedFuel) return;
    const parsedLox  = buildRows(loxRows,  'LOX');
    if (!parsedLox)  return;

    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/experiment/run_timeseries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuel: {
            water_density: parseFloat(waterDensity) || 998.2,
            rows: parsedFuel,
          },
          lox: {
            water_density: parseFloat(waterDensity) || 998.2,
            rows: parsedLox,
          },
        }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        setError(e.detail || `HTTP ${resp.status}`);
        return;
      }
      setResults(await resp.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveCdToConfig() {
    if (!results?.cda_fit) return;
    setSaveStatus('saving');
    const res = await updateConfig({
      discharge: {
        fuel:     { cda_fit_a: results.cda_fit.fuel.a, cda_fit_b: results.cda_fit.fuel.b },
        oxidizer: { cda_fit_a: results.cda_fit.lox.a,  cda_fit_b: results.cda_fit.lox.b },
      },
    } as Partial<EngineConfig>);
    if (res.error) {
      setSaveStatus('error');
    } else {
      setSaveStatus('saved');
      if (res.data?.config) onConfigUpdated?.(res.data.config);
    }
    setTimeout(() => setSaveStatus('idle'), 3000);
  }

  const coldFlowContent = (
    <div className="space-y-5">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-1">Cold-Flow Experiment</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Characterize injector CdA [m²] from water flow tests, then run the engine time-series with interpolated per-step CdA.
        </p>
      </div>

      {/* Water density config */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">Test Configuration</h3>
        <div className="flex items-center gap-4">
          <div style={{ maxWidth: 200 }}>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Water Density [kg/m³]</label>
            <input type="number" step="0.1" min="0" value={waterDensity} onChange={e => setWaterDensity(e.target.value)} className={inputCls} placeholder="998.2" />
          </div>
          {!config && (
            <p className="text-xs text-amber-400 mt-4">No engine config loaded — time-series simulation requires a loaded config.</p>
          )}
        </div>
      </div>

      {/* Two spreadsheet grids side by side */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <GridPanel
          title="Fuel — Test Runs"
          accentColor="#f97316"
          rows={fuelRows}
          onChange={setFuelRows}
          waterDensity={waterDensity}
        />
        <GridPanel
          title="LOX — Test Runs"
          accentColor="#60a5fa"
          rows={loxRows}
          onChange={setLoxRows}
          waterDensity={waterDensity}
        />
      </div>

      {/* Calculate button */}
      <button
        onClick={handleCalculate}
        disabled={loading}
        className="w-full py-3 rounded-xl font-semibold text-sm transition-colors bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>Running simulation…
          </span>
        ) : 'Run Time-Series Simulation'}
      </button>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
      )}

      {/* Results */}
      {results && <TimeseriesResults results={results} onSaveCdToConfig={handleSaveCdToConfig} saveStatus={saveStatus} />}
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-secondary)',
          flexShrink: 0,
        }}
      >
        {[
          { key: 'cold_flow' as ExperimentTab, label: 'Feed System CdA — Water Flow' },
          { key: 'press_feed' as ExperimentTab, label: 'Pressure Feed Experiment' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 18px',
              fontSize: 13,
              fontWeight: activeTab === tab.key ? 700 : 400,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              borderBottom: activeTab === tab.key ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === tab.key ? '#3b82f6' : 'var(--color-text-secondary)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'cold_flow' && coldFlowContent}
        {activeTab === 'press_feed' && (
          <PressureFeedExperiment config={config} onConfigUpdated={onConfigUpdated} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cd vs sqrt(ΔP) characterisation chart
// ---------------------------------------------------------------------------

function CdFitChart({
  fuelPairs, loxPairs, cdFit,
}: {
  fuelPairs: [number, number][];
  loxPairs:  [number, number][];
  cdFit?: { fuel: { a: number; b: number }; lox: { a: number; b: number } };
}) {
  const allDp_pa = [...fuelPairs.map(p => p[0]), ...loxPairs.map(p => p[0])];
  if (!allDp_pa.length) return null;

  const minDp_pa = Math.min(...allDp_pa) * 0.5;
  const maxDp_pa = Math.max(...allDp_pa) * 1.8;
  const N = 80;

  function evalFit(dp_pa: number, a: number, b: number) {
    return Math.max(0, a * Math.sqrt(dp_pa) + b);
  }

  // Build one merged dataset keyed by sqrt(ΔP [psi])
  // Each point has: sqrtDp, and optionally fuelFit, loxFit, fuelMeas, loxMeas
  type Pt = { sqrtDp: number; fuelFit?: number; loxFit?: number; fuelMeas?: number; loxMeas?: number };
  const byKey = new Map<number, Pt>();

  function getOrCreate(sqrtDp: number): Pt {
    const key = Math.round(sqrtDp * 1e6);
    if (!byKey.has(key)) byKey.set(key, { sqrtDp });
    return byKey.get(key)!;
  }

  // Fit curves
  if (cdFit) {
    for (let i = 0; i < N; i++) {
      const dp_pa = minDp_pa + (maxDp_pa - minDp_pa) * i / (N - 1);
      const sqrtDp = Math.sqrt(dp_pa / PSI_TO_PA);
      const pt = getOrCreate(sqrtDp);
      pt.fuelFit = evalFit(dp_pa, cdFit.fuel.a, cdFit.fuel.b);
      pt.loxFit  = evalFit(dp_pa, cdFit.lox.a,  cdFit.lox.b);
    }
  }

  // Measured points
  fuelPairs.forEach(([dp_pa, cd]) => {
    const pt = getOrCreate(Math.sqrt(dp_pa / PSI_TO_PA));
    pt.fuelMeas = cd;
  });
  loxPairs.forEach(([dp_pa, cd]) => {
    const pt = getOrCreate(Math.sqrt(dp_pa / PSI_TO_PA));
    pt.loxMeas = cd;
  });

  const chartData = Array.from(byKey.values()).sort((a, b) => a.sqrtDp - b.sqrtDp);

  const tip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-lg text-xs">
        <p className="text-[var(--color-text-secondary)] mb-1">ΔP = {(Number(label) ** 2).toFixed(1)} psi &nbsp;(√ΔP = {Number(label).toFixed(3)} psi^½)</p>
        {payload.map((e: any) => (
          <p key={e.dataKey} style={{ color: e.color }}>{e.name}: {Number(e.value).toFixed(4)}</p>
        ))}
      </div>
    );
  };

  return (
    <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-1">
        CdA Characterisation — Cold Flow Fit
      </h3>
      <p className="text-xs text-[var(--color-text-secondary)] mb-4">
        CdA = a·√ΔP<sub>pa</sub> + b [m²] &nbsp;·&nbsp; dots = measured, lines = extrapolated fit
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
          <XAxis
            dataKey="sqrtDp"
            type="number"
            domain={['auto', 'auto']}
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(2)}
            label={{ value: '√ΔP (psi^½)', position: 'insideBottom', offset: -10, fill: 'var(--color-text-secondary)', fontSize: 11 }}
          />
          <YAxis
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            label={{ value: 'CdA [m²]', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)', fontSize: 11 }}
            domain={['auto', 'auto']}
          />
          <Tooltip content={tip} />
          <Legend />
          {/* Fit lines */}
          <Line type="monotone" dataKey="fuelFit" name="Fuel fit" stroke="#f97316" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="loxFit"  name="LOX fit"  stroke="#60a5fa" strokeWidth={2} dot={false} connectNulls />
          {/* Measured scatter — lines hidden, only dots */}
          <Line type="monotone" dataKey="fuelMeas" name="Fuel meas" stroke="#f97316" strokeWidth={0} dot={{ r: 5, fill: '#f97316', strokeWidth: 2, stroke: '#fff' }} connectNulls={false} />
          <Line type="monotone" dataKey="loxMeas"  name="LOX meas"  stroke="#60a5fa" strokeWidth={0} dot={{ r: 5, fill: '#60a5fa', strokeWidth: 2, stroke: '#fff' }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convert experiment response → TimeSeriesData / TimeSeriesSummary for PressureCurveChart
// ---------------------------------------------------------------------------

function convertToTimeSeriesFormat(results: TimeseriesResponse): { data: TimeSeriesData; summary: TimeSeriesSummary } {
  const R = results.results;
  const t = results.t;
  const n = t.length;

  const nonZeroF   = R.F.filter(v => v > 0);
  const nonZeroPc  = R.Pc.filter(v => v > 0);
  const nonZeroIsp = R.Isp.filter(v => v > 0);

  const avgF   = nonZeroF.length   ? nonZeroF.reduce((a, b) => a + b, 0) / nonZeroF.length   : 0;
  const maxF   = nonZeroF.length   ? Math.max(...nonZeroF)   : 0;
  const minF   = nonZeroF.length   ? Math.min(...nonZeroF)   : 0;
  const avgPc  = nonZeroPc.length  ? nonZeroPc.reduce((a, b) => a + b, 0) / nonZeroPc.length  : 0;
  const maxPc  = nonZeroPc.length  ? Math.max(...nonZeroPc)  : 0;
  const avgIsp = nonZeroIsp.length ? nonZeroIsp.reduce((a, b) => a + b, 0) / nonZeroIsp.length : 0;

  let totalImpulse = 0;
  for (let i = 1; i < n; i++)
    totalImpulse += (R.F[i] + R.F[i - 1]) * 0.5 * (t[i] - t[i - 1]);

  const mdotTotal = R.mdot_O.map((mo, i) => mo + R.mdot_F[i]);
  let totalPropellant = 0;
  for (let i = 1; i < n; i++)
    totalPropellant += (mdotTotal[i] + mdotTotal[i - 1]) * 0.5 * (t[i] - t[i - 1]);

  const pTankO = results.pressure_curves_used?.P_tank_O_pa ?? new Array(n).fill(0);
  const pTankF = results.pressure_curves_used?.P_tank_F_pa ?? new Array(n).fill(0);

  const data: TimeSeriesData = {
    time:             t,
    P_tank_O_psi:     pTankO.map(p => p / PSI_TO_PA),
    P_tank_F_psi:     pTankF.map(p => p / PSI_TO_PA),
    Pc_psi:           R.Pc.map(p => p / PSI_TO_PA),
    thrust_kN:        R.F.map(f => f / 1000),
    Isp_s:            R.Isp,
    MR:               R.MR,
    mdot_O_kg_s:      R.mdot_O,
    mdot_F_kg_s:      R.mdot_F,
    mdot_total_kg_s:  mdotTotal,
    cstar_actual_m_s: new Array(n).fill(0),
    gamma:            new Array(n).fill(0),
    Cd_O:                    R.Cd_O,
    Cd_F:                    R.Cd_F,
    delta_P_injector_O_psi:  R.delta_p_injector_O.map(p => p / PSI_TO_PA),
    delta_P_injector_F_psi:  R.delta_p_injector_F.map(p => p / PSI_TO_PA),
  };

  const summary: TimeSeriesSummary = {
    avg_thrust_kN:       avgF / 1000,
    peak_thrust_kN:      maxF / 1000,
    min_thrust_kN:       minF / 1000,
    avg_Pc_psi:          avgPc / PSI_TO_PA,
    peak_Pc_psi:         maxPc / PSI_TO_PA,
    avg_Isp_s:           avgIsp,
    total_impulse_kNs:   totalImpulse / 1000,
    total_propellant_kg: totalPropellant,
    burn_time_s:         n > 1 ? t[n - 1] - t[0] : 0,
  };

  return { data, summary };
}

// ---------------------------------------------------------------------------
// Reynolds similarity (hotfire mean Re vs cold-flow mean Re, within 10⁻²…10²)
// ---------------------------------------------------------------------------

type ReSimilarity = NonNullable<TimeseriesResponse['re_similarity']>;

function ReSimilarityPanel({ re }: { re: ReSimilarity }) {
  const rows: {
    label: string;
    accent: string;
    meanWater: number;
    meanHot: number;
    ratio: number | null;
    ok: boolean;
  }[] = [
    {
      label: 'Fuel',
      accent: '#f97316',
      meanWater: re.mean_re_water_fuel,
      meanHot: re.mean_re_hotfire_fuel,
      ratio: re.ratio_hotfire_to_water_fuel,
      ok: re.fuel_within_two_orders,
    },
    {
      label: 'LOX',
      accent: '#60a5fa',
      meanWater: re.mean_re_water_lox,
      meanHot: re.mean_re_hotfire_lox,
      ratio: re.ratio_hotfire_to_water_lox,
      ok: re.lox_within_two_orders,
    },
  ];

  const allOk = rows.every(r => r.ok);

  return (
    <div
      className={`p-4 rounded-xl border ${
        allOk ? 'bg-emerald-500/5 border-emerald-500/25' : 'bg-amber-500/5 border-amber-500/30'
      }`}
    >
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-1">
        Reynolds similarity (injector, choke-based)
      </h3>
      <p className="text-xs text-[var(--color-text-secondary)] mb-4">
        Mean Re from the time-series (hot, propellant properties) compared to the mean Re from water test rows.
        Pass if hotfire/water ratio is between 10<sup>-2</sup> and 10<sup>2</sup> (two orders of magnitude).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rows.map(row => (
          <div
            key={row.label}
            className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]"
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-semibold" style={{ color: row.accent }}>{row.label}</span>
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded ${
                  row.ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                }`}
              >
                {row.ok ? 'Pass' : 'Outside range'}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs font-mono">
              <dt className="text-[var(--color-text-secondary)]">Mean Re (water)</dt>
              <dd className="text-right text-[var(--color-text-primary)]">{fmtSci(row.meanWater)}</dd>
              <dt className="text-[var(--color-text-secondary)]">Mean Re (hotfire)</dt>
              <dd className="text-right" style={{ color: row.accent }}>{fmtSci(row.meanHot)}</dd>
              <dt className="text-[var(--color-text-secondary)]">Ratio (hot / water)</dt>
              <dd className="text-right text-[var(--color-text-primary)]">
                {row.ratio != null && Number.isFinite(row.ratio) ? fmtSci(row.ratio) : '—'}
              </dd>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results display
// ---------------------------------------------------------------------------

function TimeseriesResults({ results, onSaveCdToConfig, saveStatus }: {
  results: TimeseriesResponse;
  onSaveCdToConfig: () => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
}) {
  const R = results.results;
  const nonZero = R.F.filter(v => v > 0);

  const summaryCards = [
    { label: 'Avg Chamber Pressure', value: fmtSci(avg(R.Pc.filter(v => v > 0))), sub: 'Pa' },
    { label: 'Avg Thrust',           value: fmtN(avg(nonZero), 1),               sub: 'N' },
    { label: 'Avg Isp',              value: fmtN(avg(R.Isp.filter(v => v > 0)), 1), sub: 's' },
    { label: 'Avg O/F Ratio',        value: fmtN(avg(R.MR.filter(v => v > 0)), 3),  sub: '—' },
  ];

  return (
    <div className="space-y-5">
      {/* Cd vs sqrt(ΔP) characterisation chart */}
      <CdFitChart
        fuelPairs={results.fuel_cda_pressure_pairs}
        loxPairs={results.lox_cda_pressure_pairs}
        cdFit={results.cda_fit}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {summaryCards.map(c => (
          <div key={c.label} className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-secondary)] mb-1">{c.label}</p>
            <p className="text-xl font-bold text-amber-400">{c.value}</p>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Reynolds: hotfire vs cold-flow (same choke-based definition as spreadsheet) */}
      {results.re_similarity && (
        <ReSimilarityPanel re={results.re_similarity} />
      )}

      {/* Fit + pressure curve metadata */}
      {(results.cda_fit || results.pressure_curves_used) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)] uppercase tracking-wider mb-3">Operating Curves Used</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            {results.cda_fit && (
              <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)] mb-1">CdA fit model</p>
                <p className="text-[var(--color-text-primary)] font-mono text-xs">{results.cda_fit.fuel.model}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                  <div>
                    <p className="text-[var(--color-text-secondary)]">Fuel a</p>
                    <p className="text-[#f97316]">{results.cda_fit.fuel.a.toExponential(3)}</p>
                  </div>
                  <div>
                    <p className="text-[var(--color-text-secondary)]">Fuel b</p>
                    <p className="text-[#f97316]">{results.cda_fit.fuel.b.toExponential(4)}</p>
                  </div>
                  <div>
                    <p className="text-[var(--color-text-secondary)]">LOX a</p>
                    <p className="text-[#60a5fa]">{results.cda_fit.lox.a.toExponential(3)}</p>
                  </div>
                  <div>
                    <p className="text-[var(--color-text-secondary)]">LOX b</p>
                    <p className="text-[#60a5fa]">{results.cda_fit.lox.b.toExponential(4)}</p>
                  </div>
                </div>
                <button
                  onClick={onSaveCdToConfig}
                  disabled={saveStatus === 'saving'}
                  className="mt-3 w-full px-3 py-2 rounded-lg text-xs font-semibold transition-colors bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved to Config' : saveStatus === 'error' ? 'Save Failed' : 'Save CdA to Config'}
                </button>
              </div>
            )}

            {results.pressure_curves_used && (
              <>
                <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-secondary)] mb-1">LOX tank pressure (avg)</p>
                  <p className="text-[#60a5fa] font-mono">{fmtSci(avg(results.pressure_curves_used.P_tank_O_pa))} Pa</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    min {fmtSci(Math.min(...results.pressure_curves_used.P_tank_O_pa))} / max {fmtSci(Math.max(...results.pressure_curves_used.P_tank_O_pa))}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-secondary)] mb-1">Fuel tank pressure (avg)</p>
                  <p className="text-[#f97316] font-mono">{fmtSci(avg(results.pressure_curves_used.P_tank_F_pa))} Pa</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    min {fmtSci(Math.min(...results.pressure_curves_used.P_tank_F_pa))} / max {fmtSci(Math.max(...results.pressure_curves_used.P_tank_F_pa))}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Cd characterisation tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CdTable title="Fuel CdA vs ΔP" accentColor="#f97316" pairs={results.fuel_cda_pressure_pairs} />
        <CdTable title="LOX CdA vs ΔP"  accentColor="#60a5fa" pairs={results.lox_cda_pressure_pairs}  />
      </div>

      {/* All the same plots as Time-Series Analysis tab */}
      {(() => {
        const { data, summary } = convertToTimeSeriesFormat(results);
        return <PressureCurveChart data={data} summary={summary} />;
      })()}
    </div>
  );
}

function CdTable({ title, accentColor, pairs }: { title: string; accentColor: string; pairs: [number, number][] }) {
  return (
    <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <h3 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: accentColor }}>{title}</h3>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, fontFamily: 'ui-monospace, monospace', width: '100%' }}>
        <thead>
          <tr>
            {['ΔP [psi]', 'CdA [m²]'].map(h => (
              <th key={h} style={{ padding: '3px 8px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pairs.map(([dp_pa, cda], i) => (
            <tr key={i}>
              <td style={{ padding: '3px 8px', textAlign: 'right', color: 'var(--color-text-primary)' }}>{fmtN(dp_pa / PSI_TO_PA, 2)}</td>
              <td style={{ padding: '3px 8px', textAlign: 'right', color: accentColor }}>{cda.toExponential(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

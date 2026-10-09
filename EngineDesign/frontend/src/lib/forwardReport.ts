/**
 * Forward mode's result (engine/pipeline/forward_report.py): every quantity computed once on the
 * backend, with its unit, basis, status and the unmeasured inputs it rests on. Nothing here derives
 * physics; it formats, and it reads burn ranges out of a Time-Series run.
 */
import type { TimeSeriesData } from '../api/client';

export type Status = 'ok' | 'warn' | 'bad' | 'unknown';

export interface Quantity {
  key: string;
  label: string;
  value: number | string | null;
  unit: string;
  digits: number;
  basis: string;
  assumed: string[];
  status?: Status;
  detail?: boolean;
}

export interface Verdict extends Omit<Quantity, 'status' | 'detail'> {
  status: Status;
  threshold: string;
}

export interface Section {
  key: string;
  title: string;
  summary: string[];
  quantities: Quantity[];
}

export interface Calibration {
  label: string;
  where: string;
  basis: string;
  state: 'assumed' | 'partial' | 'measured';
  sources?: string[];
}

/** A measured value as the config holds it (engine/pipeline/config_schemas.MeasuredValue). */
export interface MeasuredValue { value: number; uncertainty?: number | null; source: string; date?: string | null }

/** What can be measured, which calibration input it settles, and its unit. */
export const MEASURABLE: { key: string; label: string; unit: string; closes: string; digits: number }[] = [
  { key: 'cd_O', label: 'Cd, LOX', unit: '', closes: 'cd', digits: 3 },
  { key: 'cd_F', label: 'Cd, fuel', unit: '', closes: 'cd', digits: 3 },
  { key: 'em', label: 'Mixing factor E_m', unit: '', closes: 'em', digits: 3 },
  { key: 'd32_O_um', label: 'D32, LOX', unit: 'µm', closes: 'smd', digits: 0 },
  { key: 'd32_F_um', label: 'D32, fuel', unit: 'µm', closes: 'smd', digits: 0 },
  { key: 'nozzle_efficiency', label: 'Nozzle efficiency ζ_n', unit: '', closes: 'nozzle', digits: 3 },
  { key: 'chug_frequency_hz', label: 'Chug frequency (hot fire)', unit: 'Hz', closes: '', digits: 0 },
];

export interface HandcheckRow {
  quantity: string;
  model: string;
  hand: string;
  diff: string;
  ok: boolean;
  source: string;
  kind: 'compare' | 'bound' | 'info';
}

export interface ForwardReport {
  headline: Quantity[];
  verdicts: Verdict[];
  sections: Section[];
  calibration: Record<string, Calibration>;
  stability: unknown;
  handcheck: { rows: HandcheckRow[]; flags: string[]; error?: string } | null;
}

/** A number at its declared precision; '—' when there is none. */
export function fmt(v: number | string | null | undefined, digits = 3): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Headline quantity -> the Time-Series column that carries it over the burn. */
const BURN_SERIES: Record<string, keyof TimeSeriesData> = {
  F: 'thrust_kN',
  Isp: 'Isp_s',
  Pc: 'Pc_psi',
  OF: 'MR',
  mdot: 'mdot_total_kg_s',
};

/** [min, max] of a headline quantity over a Time-Series burn, when the burn carries it. */
export function burnRange(key: string, ts: TimeSeriesData | null | undefined): [number, number] | null {
  const col = BURN_SERIES[key];
  if (!ts || !col) return null;
  const xs = (ts[col] as number[] | undefined)?.filter((x) => Number.isFinite(x)) ?? [];
  if (xs.length < 2) return null;
  return [Math.min(...xs), Math.max(...xs)];
}

export function sectionSummary(s: Section): Quantity[] {
  return s.summary.map((k) => s.quantities.find((q) => q.key === k)).filter((q): q is Quantity => !!q);
}

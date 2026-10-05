import { fmt } from '../../layerx/format';
import { NBSP } from '../units';

/** What a Field's typed text means: a number, nothing (blank), or not a number. */
export type Parsed = { kind: 'number'; value: number } | { kind: 'empty' } | { kind: 'invalid' };

/**
 * Typed text to a number. Forgiving about what a person pastes ("1,234.5", "−3", "+2", "4.5e2",
 * a trailing unit's space), strict about anything else: "12abc" is not 12.
 */
export function parseNumber(text: string): Parsed {
  const t = text.replace(/[\s\u00a0,_]/g, '').replace(/[\u2212\u2013]/g, '-');
  if (t === '') return { kind: 'empty' };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return { kind: 'invalid' };
  const v = Number(t);
  return Number.isFinite(v) ? { kind: 'number', value: v } : { kind: 'invalid' };
}

/** The input's text for a value: its digits, no grouping (a typed field is edited, not read). */
export function editText(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const t = v.toFixed(Math.max(0, Math.min(digits, 20)));
  return Number(t) === 0 ? (0).toFixed(Math.max(0, Math.min(digits, 20))) : t;
}

/** Two values that print the same at the field's digits are the same value. */
export function sameAtDigits(a: number | null | undefined, b: number | null | undefined, digits: number): boolean {
  const na = a === null || a === undefined || !Number.isFinite(a);
  const nb = b === null || b === undefined || !Number.isFinite(b);
  if (na || nb) return na && nb;
  return editText(a, digits) === editText(b, digits);
}

/**
 * The inline message for a typed value, or null when it may be committed. Bounds and the value are
 * in display units.
 */
export function fieldError(p: Parsed, rules: {
  min?: number; max?: number; allowEmpty?: boolean; unit?: string; digits: number;
  validate?: (v: number | null) => string | null;
}): string | null {
  const u = rules.unit ? `${NBSP}${rules.unit}` : '';
  if (p.kind === 'invalid') return 'Not a number';
  if (p.kind === 'empty') return rules.allowEmpty ? rules.validate?.(null) ?? null : 'Needs a value';
  if (rules.min !== undefined && p.value < rules.min) return `At least ${fmt(rules.min, rules.digits)}${u}`;
  if (rules.max !== undefined && p.value > rules.max) return `At most ${fmt(rules.max, rules.digits)}${u}`;
  return rules.validate?.(p.value) ?? null;
}

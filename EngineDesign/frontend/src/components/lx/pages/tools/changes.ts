import type { ChangeList, ChangeRecord } from '../../../../api/layerx';
import { fmt } from '../../../layerx/format';
import { STD_ATM_PSIA, type Quantity, type Units } from '../../units';

/**
 * The change list (engine/layerx/diff.py, schema layerx.change-list/1) as the Optimize and Injector
 * tools print it: one row per change (component, P&ID node, before -> after, its effect, CAD impact),
 * the figures the verifying burn moved, and the JSON a person takes away. Pure, so tested.
 *
 * A change's own before/after stay in the units the backend wrote them in (psig on a dial, mm on a
 * drill): the list is the engineering record, and the stand and the shop read those units. The
 * figures go through the page's unit system like every other number on Layer X.
 */

/** A plain number with its own unit: about four significant figures, the unit after a no-break space. */
export function plainText(v: number | string | null | undefined, unit = ''): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a === 0 ? 0 : a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  const u = unit && unit !== '-' ? `\u00a0${unit}` : '';
  return `${fmt(v, digits)}${u}`;
}

/** What a field is, in words: the backend's field names are code. */
const FIELD_WORDS: Record<string, string> = {
  dome_psig: 'dome dial', lockup_psia: 'lockup', copv_psig: 'bottle fill', K_minor: 'loss coefficient K', d_jet: 'hole diameter',
  orifice_l_over_d: 'passage L/d', impingement_angle: 'jet angle', cv: 'Cv', Cv: 'Cv', bore: 'bore', fuel_lead_s: 'fuel lead',
};
export const fieldWords = (f: string): string => FIELD_WORDS[f] ?? f.replace(/_/g, ' ');

/** The component without the field the backend appended to its label ("Bottle fill copv_psig"). */
export function componentWords(c: Pick<ChangeRecord, 'component' | 'label' | 'field'>): string {
  return c.component || (c.label ?? '').replace(new RegExp(`\\s*${c.field}$`), '') || '—';
}

export interface ChangeRow {
  key: string;
  component: string;
  node: string | null;
  field: string;
  before: string;
  after: string;
  /** Signed after minus before, when both are numbers. */
  change: string | null;
  cad: ChangeRecord['cad_impact'];
  domain: ChangeRecord['domain'];
  source: string;
  note: string;
}

export function changeRows(cl: Pick<ChangeList, 'changes'> | null | undefined): ChangeRow[] {
  return (cl?.changes ?? []).map((c, k) => {
    const unit = c.unit ?? '';
    const num = typeof c.before === 'number' && typeof c.after === 'number' && Number.isFinite(c.before) && Number.isFinite(c.after);
    const d = num ? (c.after as number) - (c.before as number) : null;
    return {
      key: `${c.target}:${c.field}:${k}`,
      component: componentWords(c),
      node: c.pid_node_id ?? null,
      field: fieldWords(c.field),
      before: plainText(c.before, unit),
      after: plainText(c.after, unit),
      change: d === null ? null : `${d > 0 ? '+' : d < 0 ? '−' : ''}${plainText(Math.abs(d), unit)}`,
      cad: c.cad_impact,
      domain: c.domain,
      source: c.source ?? '',
      note: [c.note, c.before_provenance ? `before: ${c.before_provenance}` : '', c.provenance ? `after: ${c.provenance}` : ''].filter(Boolean).join(' · '),
    };
  });
}

/** CAD impact in stand words, worst first for sorting a list. */
export const CAD_WORDS: Record<ChangeRecord['cad_impact'], string> = {
  'new part': 'new part', 'new plate': 'new plate', 're-drill': 're-drill', 'setting only': 'a setting', none: 'none',
};
export const CAD_RANK: Record<ChangeRecord['cad_impact'], number> = { 'new part': 0, 'new plate': 1, 're-drill': 2, 'setting only': 3, none: 4 };

/** The worst CAD impact on the list: what the change costs the shop. */
export function worstCad(cl: Pick<ChangeList, 'changes'> | null | undefined): ChangeRecord['cad_impact'] | null {
  const all = (cl?.changes ?? []).map((c) => c.cad_impact).filter((c): c is ChangeRecord['cad_impact'] => c in CAD_RANK);
  return all.length ? all.sort((a, b) => CAD_RANK[a] - CAD_RANK[b])[0] : null;
}

/** A figure's value in the page's units, from the unit the backend names it in. */
export function figureQuantity(u: Units, key: string, unit: string, v: number | null | undefined): Quantity | string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'N': return u.f(v);
    case 'N·s': case 'N s': return u.impulse(v);
    case 'psia': return u.p(v);
    case 'psig': return u.p(v + STD_ATM_PSIA, 'gauge', STD_ATM_PSIA);
    case 'psi': return u.gap(v);
    case 's': return u.time(v);
    case 'kg': return u.m(v);
    case '%': return `${fmt(v, 2)}\u00a0%`;
    case '': case '-':
      if (/stiffness/.test(key)) return u.pct(v);
      if (/^of|_of_|of_mean/.test(key)) return u.of(v);
      if (/limits_bad|count/.test(key)) return fmt(v, 0);
      return u.ratio(v);
    default: return plainText(v, unit);
  }
}

const text = (u: Units, x: Quantity | string) => (typeof x === 'string' ? x : u.fmt(x));

/** A signed change in a figure's own display units ("+186 N", "−0.08 s"). */
export function figureDelta(u: Units, key: string, unit: string, before: number | null | undefined, after: number | null | undefined): string {
  if (before === null || before === undefined || after === null || after === undefined || !Number.isFinite(before) || !Number.isFinite(after)) return '—';
  const a = figureQuantity(u, key, unit, after);
  const b = figureQuantity(u, key, unit, before);
  if (typeof a === 'string' || typeof b === 'string') {
    const d = after - before;
    return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${plainText(Math.abs(d), unit === '-' ? '' : unit)}`;
  }
  const d = Number((a.value - b.value).toFixed(a.digits));
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return `${sign}${u.fmt({ ...a, value: Math.abs(d) })}`;
}

export interface EffectRow { key: string; label: string; before: string; after: string; change: string }

/** The figures the verifying burn moved, in the page's units; the dials themselves left to the rows. */
export function effectRows(u: Units, cl: Pick<ChangeList, 'effects'> | null | undefined): EffectRow[] {
  return (cl?.effects ?? [])
    .filter((e) => e.key !== 'dome_psig' && e.key !== 'lockup_psia')
    .map((e) => ({
      key: e.key,
      label: e.label,
      before: e.before === null || e.before === undefined ? '—' : text(u, figureQuantity(u, e.key, e.unit ?? '', e.before)),
      after: e.after === null || e.after === undefined ? '—' : text(u, figureQuantity(u, e.key, e.unit ?? '', e.after)),
      change: figureDelta(u, e.key, e.unit ?? '', e.before, e.after),
    }));
}

/** The figures a row's effect column names: the ones a person checks first. */
const KEY_EFFECTS = ['mean_thrust_N', 'of_mean', 'burn_time_s'] as const;

/**
 * A change's effect on the key figures, in words ("+186 N · −0.0006 O/F"). The backend charges every
 * change of a list with the list's combined effect (one verifying burn), so with more than one change
 * the words say "together".
 */
export function rowEffect(u: Units, cl: Pick<ChangeList, 'effects' | 'changes'>, c: Pick<ChangeRecord, 'effect'>): string {
  const parts: string[] = [];
  for (const k of KEY_EFFECTS) {
    const e = cl.effects?.find((x) => x.key === k);
    const d = c.effect?.[k];
    if (!e || d === null || d === undefined || !Number.isFinite(d) || e.before === null || e.before === undefined) continue;
    const word = k === 'of_mean' ? ' O/F' : '';
    parts.push(`${figureDelta(u, k, e.unit ?? '', e.before, e.before + d)}${word}`);
  }
  return parts.join(' · ');
}

/** The file a person takes away: the list as the backend wrote it, with where it came from. */
export function changeListJson(cl: ChangeList, meta: { runId: string; tool: string; design?: string | null; drawing?: string | null }): string {
  return `${JSON.stringify({ ...cl, source: { run: meta.runId, tool: meta.tool, design: meta.design ?? null, drawing: meta.drawing ?? null } }, null, 2)}\n`;
}

export function changeListFilename(tool: string, runId: string): string {
  return `layerx-${tool}-changes-${runId}.json`;
}

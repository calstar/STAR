import type { LayerXSettings, RunView } from '../../api/layerx';
import { fmt, FT } from './format';

/** When a run started, short: "Oct 2, 01:45 PM". */
export function runWhen(r: Pick<RunView, 'started'>): string {
  return new Date(r.started * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STEM_WORDS: Record<string, string> = { copv: 'COPV', gn2: 'GN2', he: 'helium', n2: 'N2', ln2: 'LN2', lox: 'LOX', le4: 'LE4' };
const GAS_WORDS = new Set(['GN2', 'helium', 'N2', 'LN2']);

/**
 * A drawing's name in words: a file stem ("copv_study_he", what a shipped drawing is named by) as
 * "COPV study, helium"; a name a person chose ("LE4 (6)") as it is. The server's
 * engine/layerx/sources.py display_name, for runs and drawings listed before it sent a label.
 */
export function drawingWords(name: string | null | undefined): string {
  const n = name ?? '';
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(n)) return n;
  const words = n.split('_').map((w) => STEM_WORDS[w] ?? w);
  const text = words.length > 2 && GAS_WORDS.has(words[words.length - 1])
    ? `${words.slice(0, -1).join(' ')}, ${words[words.length - 1]}` : words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a listed run was: drawing, tank pressure, gas, flown, a what-if. Two runs a minute apart
 * must be told apart without opening them. */
export function runContext(r: RunView): string {
  const st = r.settings ?? ({} as Partial<LayerXSettings>);
  return [
    r.drawing?.name ? drawingWords(r.drawing.name) : null,
    st.tank_pressure_psia ? `${fmt(st.tank_pressure_psia, 0)} psia` : null,
    st.pressurant === 'helium' ? 'He' : st.pressurant === 'nitrogen' ? 'GN2' : null,
    st.flight ? 'flown' : null,
    st.design_patch ? 'what-if' : null,
  ].filter(Boolean).join(' · ') || r.kind || 'burn';
}

/** A run in one line: its name or when, how, and what it made. */
export function runLabel(r: Pick<RunView, 'started' | 'settings' | 'summary' | 'meta' | 'drawing'>): string {
  return `${r.meta?.name || runWhen(r)} · ${runContext(r as RunView)}${r.summary ? ` · ${fmt(r.summary.total_impulse_Ns / 1000, 2)} kN·s` : ''}`;
}

/** The figures a finished burn is listed with. */
export function runFigures(r: RunView): string {
  if (r.status !== 'done') return r.status;
  if (!r.summary) return '';
  return `${fmt(r.summary.total_impulse_Ns / 1000, 2)} kN·s${r.summary.apogee_agl_m ? ` · ${fmt(r.summary.apogee_agl_m * FT, 0)} ft` : ''}`;
}

/** What each kind of job is called on the page. */
export const KIND_WORD: Record<string, string> = {
  run: 'burn', uncertainty: 'sweep', optimize: 'search', reconcile: 'injector solve', trade: 'trade study',
};

/** Pinned first, then newest first. */
export function byPinThenNewest(a: RunView, b: RunView): number {
  return Number(!!b.meta?.pinned) - Number(!!a.meta?.pinned) || b.started - a.started;
}

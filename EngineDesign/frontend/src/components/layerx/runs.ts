import type { LayerXSettings, RunView } from '../../api/layerx';
import { fmt, FT } from './format';

/** When a run started, short: "Oct 2, 01:45 PM". */
export function runWhen(r: Pick<RunView, 'started'>): string {
  return new Date(r.started * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** What a listed run was: drawing, tank pressure, gas, flown, a what-if. Two runs a minute apart
 * must be told apart without opening them. */
export function runContext(r: RunView): string {
  const st = r.settings ?? ({} as Partial<LayerXSettings>);
  return [
    r.drawing?.name,
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

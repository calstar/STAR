import { fmt } from '../../layerx/format';
import type { TimeEvent } from './store';

/**
 * Where the timeline's event markers go, and which of their labels fit. Every event keeps its
 * tick; a label is dropped when it would overlap one that matters more. Pure, so the thinning is
 * tested rather than eyeballed.
 */

/** Which label survives a crowd. Unknown kinds rank last. */
export const KIND_PRIORITY: Record<string, number> = {
  // A vessel trip stops the burn where it is: nothing on the line matters more.
  trip: 110,
  fire: 100,
  burnout: 90,
  t0: 80,
  end: 75,
  dry: 70,
  ignition: 60,
  min: 50,
  lead: 40,
  warn: 30,
};

export function priorityOf(e: Pick<TimeEvent, 'kind'>): number {
  return KIND_PRIORITY[e.kind] ?? 10;
}

export interface PlacedMarker {
  /** The first event's key in the group. */
  key: string;
  /** The group's time: its highest-priority event's. */
  t: number;
  /** Tick position [px from the track's left]. */
  x: number;
  /** The label shown, from the highest-priority event. */
  label: string;
  kind: string;
  /** Every event at this tick, in time order (a hover lists them all). */
  events: TimeEvent[];
  showLabel: boolean;
  /** Label box, clamped inside the track [px]. */
  labelLeft: number;
  labelWidth: number;
}

export interface MarkerLayout {
  /** Maps a time to px from the track's left. */
  x: (t: number) => number;
  /** Track width [px]. */
  width: number;
  /** Label width [px]. */
  measure: (label: string) => number;
  /** Clear space between two labels [px]. */
  gap?: number;
  /** Ticks closer than this merge into one [px]. */
  mergePx?: number;
}

/** Ticks for every event inside the track, labels only where they fit, highest priority first. */
export function layoutMarkers(events: readonly TimeEvent[], opts: MarkerLayout): PlacedMarker[] {
  const { width, measure } = opts;
  const gap = opts.gap ?? 8;
  const mergePx = opts.mergePx ?? 3;
  if (!(width > 0)) return [];

  const inside = events
    .map((e) => ({ e, x: opts.x(e.t) }))
    .filter(({ x }) => Number.isFinite(x) && x >= -0.5 && x <= width + 0.5)
    .sort((a, b) => a.x - b.x || priorityOf(b.e) - priorityOf(a.e));

  // Group ticks that would draw on top of each other.
  const groups: { x0: number; members: { e: TimeEvent; x: number }[] }[] = [];
  for (const item of inside) {
    const last = groups[groups.length - 1];
    if (last && item.x - last.x0 <= mergePx) last.members.push(item);
    else groups.push({ x0: item.x, members: [item] });
  }

  const placed: PlacedMarker[] = groups.map((g) => {
    const lead = g.members.reduce((best, m) => (priorityOf(m.e) > priorityOf(best.e) ? m : best));
    const labelWidth = Math.min(measure(lead.e.label), width);
    const labelLeft = Math.min(Math.max(lead.x - labelWidth / 2, 0), width - labelWidth);
    return {
      key: g.members[0].e.key,
      t: lead.e.t,
      x: lead.x,
      label: lead.e.label,
      kind: lead.e.kind,
      events: g.members.map((m) => m.e).sort((a, b) => a.t - b.t),
      showLabel: false,
      labelLeft,
      labelWidth,
    };
  });

  // Greedy by priority: a label is kept when it clears every label already kept.
  const order = [...placed].sort((a, b) => priorityOf(b) - priorityOf(a) || a.t - b.t);
  const kept: { l: number; r: number }[] = [];
  for (const m of order) {
    if (!m.label) continue;
    const l = m.labelLeft;
    const r = m.labelLeft + m.labelWidth;
    if (kept.every((k) => r + gap <= k.l || l >= k.r + gap)) {
      kept.push({ l, r });
      m.showLabel = true;
    }
  }
  return placed;
}

/** The cursor as the stand says it: "T+1.85 s", "T−0.40 s". */
export function formatT(t: number, digits = 2): string {
  if (!Number.isFinite(t)) return 'T —';
  const shown = Number(Math.abs(t).toFixed(digits));
  const sign = t < 0 && shown !== 0 ? '−' : '+';
  return `T${sign}${fmt(shown, digits)}\u00a0s`;
}

/** Decimals the cursor readout needs to tell two samples apart (10 ms data: 2). */
export function timeDigits(ts: readonly number[]): number {
  if (ts.length < 2) return 2;
  const dt = (ts[ts.length - 1] - ts[0]) / (ts.length - 1);
  if (!(dt > 0)) return 2;
  return Math.min(3, Math.max(1, Math.ceil(-Math.log10(dt) - 1e-9)));
}

/** Fire to burnout, from the events: the span the timeline shades as firing. */
export function firingSpan(events: readonly TimeEvent[]): [number, number] | null {
  const fire = events.find((e) => e.kind === 'fire');
  if (!fire) return null;
  const after = (k: (e: TimeEvent) => boolean) => events.find((e) => k(e) && e.t > fire.t);
  const end = after((e) => e.kind === 'burnout') ?? after((e) => e.kind === 'end' || e.kind === 'dry');
  return end ? [fire.t, end.t] : null;
}

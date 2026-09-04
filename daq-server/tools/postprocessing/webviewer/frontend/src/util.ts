import type { Series } from './types';
import { seriesColour } from './chartTheme';

export function colorFor(i: number): string {
  return seriesColour(i);
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return '\u2013';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '\u2013';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Merge per-channel series (each with its own timestamps) into the aligned
 * matrix uPlot needs: a single shared x plus one y row per series.
 *
 * Continuous series keep NaN between their own samples (uPlot spanGaps connects
 * them); discrete series are forward-filled so step lines hold their level.
 */
export function mergeForUplot(series: Series[]): (number | null)[][] {
  if (series.length === 0) return [[]];

  // Union of all timestamps.
  const set = new Set<number>();
  for (const s of series) for (const t of s.t) set.add(t);
  const xs = Array.from(set).sort((a, b) => a - b);
  const idxOf = new Map<number, number>();
  xs.forEach((t, i) => idxOf.set(t, i));

  const rows: (number | null)[][] = [xs];
  for (const s of series) {
    const row: (number | null)[] = new Array(xs.length).fill(null);
    for (let i = 0; i < s.t.length; i++) {
      const j = idxOf.get(s.t[i]);
      if (j !== undefined) row[j] = s.v[i];
    }
    if (s.discrete) {
      let last: number | null = null;
      for (let i = 0; i < row.length; i++) {
        if (row[i] == null) row[i] = last;
        else last = row[i];
      }
    }
    rows.push(row);
  }
  return rows;
}

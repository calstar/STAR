/**
 * A DAQ export read back in: the web viewer's wide CSV (`time,<channel>,...`, an optional second
 * header row of roles) or its long CSV (`time,component,value`), and the plain shape any
 * spreadsheet writes. Time is whatever the file's time column holds (epoch or run seconds);
 * Fire is found in it, not assumed.
 */

export interface DaqData {
  /** Time per row [s], as the file has it. */
  t: number[];
  /** Column name to its values on ``t`` (null where the file has no sample). */
  columns: Record<string, (number | null)[]>;
  shape: 'wide' | 'long';
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const TIME_NAMES = ['time', 't', 't_s', 'time_s', 'timestamp', 'seconds'];

export function parseDaqCsv(text: string): DaqData {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (lines.length < 2) throw new Error('The file has no rows.');
  const head = splitRow(lines[0]).map((h) => h.toLowerCase() === h ? h : h);
  const lower = head.map((h) => h.toLowerCase());
  if (lower.length >= 3 && lower[0] === 'time' && lower[1] === 'component' && lower[2] === 'value') {
    // Long: one row per sample. Pivot on the union of times.
    const byName = new Map<string, Map<number, number>>();
    const times = new Set<number>();
    for (const line of lines.slice(1)) {
      const [ts, name, vs] = splitRow(line);
      const t = Number(ts);
      const v = Number(vs);
      if (!Number.isFinite(t) || !name || !Number.isFinite(v)) continue;
      times.add(t);
      if (!byName.has(name)) byName.set(name, new Map());
      byName.get(name)!.set(t, v);
    }
    const t = [...times].sort((a, b) => a - b);
    const columns: DaqData['columns'] = {};
    for (const [name, m] of byName) columns[name] = t.map((x) => m.get(x) ?? null);
    return { t, columns, shape: 'long' };
  }
  const ti = lower.findIndex((h) => TIME_NAMES.includes(h));
  if (ti < 0) throw new Error(`No time column: expected one of ${TIME_NAMES.join(', ')}.`);
  let body = lines.slice(1);
  // The web viewer's second header row (roles) starts with an empty time cell.
  if (body.length && splitRow(body[0])[ti] === '') body = body.slice(1);
  const t: number[] = [];
  const columns: DaqData['columns'] = {};
  head.forEach((h, k) => { if (k !== ti && h) columns[h] = []; });
  for (const line of body) {
    const cells = splitRow(line);
    const tv = Number(cells[ti]);
    if (!Number.isFinite(tv)) continue;
    t.push(tv);
    head.forEach((h, k) => {
      if (k === ti || !h) return;
      const v = cells[k] === undefined || cells[k] === '' ? NaN : Number(cells[k]);
      columns[h].push(Number.isFinite(v) ? v : null);
    });
  }
  return { t, columns, shape: 'wide' };
}

/** The file's column for a DAQ channel: its exact name, or the one whose name carries it as a
 * whole word (`board3.PT_OUP.psi` for `PT_OUP`). */
export function matchColumn(data: DaqData, channel: string): string | null {
  const names = Object.keys(data.columns);
  const exact = names.find((n) => n === channel);
  if (exact) return exact;
  const ch = channel.toLowerCase();
  return names.find((n) => n.toLowerCase().split(/[^a-z0-9_]+/).includes(ch)) ?? null;
}

/** A column's values with gaps carried forward from the last sample. */
export function filled(values: (number | null)[]): (number | null)[] {
  let last: number | null = null;
  return values.map((v) => (v === null ? last : (last = v)));
}

/**
 * Where Fire is in the file, from one channel that jumps at Fire (an injector-side transducer,
 * main valve shut until Fire): the first time it crosses halfway from its value before the jump
 * to its value after it, as the prediction has them. ``null`` when it never does.
 */
export function findFire(t: number[], values: (number | null)[], before: number, after: number): number | null {
  const mid = 0.5 * (before + after);
  const rising = after > before;
  const v = filled(values);
  for (let i = 1; i < t.length; i++) {
    const a = v[i - 1];
    const b = v[i];
    if (a === null || b === null) continue;
    if (rising ? a < mid && b >= mid : a > mid && b <= mid) {
      // Linear between the two samples: a 100 Hz DAQ puts Fire within a few ms.
      return t[i - 1] + ((mid - a) / (b - a)) * (t[i] - t[i - 1]);
    }
  }
  return null;
}

/** Measured minus predicted over a window: the mean (bias) and the RMS (scatter). */
export function residual(tPred: number[], pred: (number | null)[], tMeas: number[], meas: (number | null)[],
  from: number, to: number): { mean: number; rms: number; n: number } | null {
  const v = filled(meas);
  let k = 0;
  const diffs: number[] = [];
  for (let i = 0; i < tPred.length; i++) {
    const tp = tPred[i];
    const p = pred[i];
    if (tp < from || tp > to || p === null || !Number.isFinite(p)) continue;
    while (k < tMeas.length - 1 && tMeas[k + 1] <= tp) k++;
    const m = v[k];
    if (m === null || Math.abs(tMeas[k] - tp) > 0.25) continue;
    diffs.push(m - p);
  }
  if (!diffs.length) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const rms = Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length);
  return { mean, rms, n: diffs.length };
}

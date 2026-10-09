/** Status, the one thing the status colours mean. Always shown with its glyph, never colour alone. */
export type Status = 'ok' | 'warn' | 'bad';

export const STATUS_GLYPH: Record<Status, string> = { ok: '✓', warn: '!', bad: '✗' };
export const STATUS_WORD: Record<Status, string> = { ok: 'Within limits', warn: 'Worth a look', bad: 'Fails' };
export const STATUS_VAR: Record<Status, string> = { ok: 'var(--lx-ok)', warn: 'var(--lx-warn)', bad: 'var(--lx-bad)' };
export const STATUS_SOFT: Record<Status, string> = { ok: 'var(--lx-ok-soft)', warn: 'var(--lx-warn-soft)', bad: 'var(--lx-bad-soft)' };

const RANK: Record<Status, number> = { bad: 0, warn: 1, ok: 2 };

/** The worst of several: one failing limit fails the burn. Nothing graded is ok. */
export function worst(statuses: Iterable<Status>): Status {
  let w: Status = 'ok';
  for (const s of statuses) if (RANK[s] < RANK[w]) w = s;
  return w;
}

/** Sort key: bad first, then warn, then ok. */
export function statusRank(s: Status): number {
  return RANK[s];
}

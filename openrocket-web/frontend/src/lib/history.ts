/**
 * Undo/redo for the document, as a pure value.
 *
 * Every edit pushes. Edits that carry the same `key` within `coalesceMs` of
 * each other merge into one step -- typing "0.125" into a field is one undo,
 * not five, and dragging a fin point is one undo, not a hundred.
 */

export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** Key and time of the last push, for coalescing. */
  lastKey: string | null
  lastAt: number
  /** Human labels for the undo/redo menu entries, parallel to past/future. */
  pastLabels: string[]
  futureLabels: string[]
  presentLabel: string
}

export const HISTORY_LIMIT = 200

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0, pastLabels: [], futureLabels: [], presentLabel: '' }
}

export interface PushOptions {
  label?: string
  key?: string
  now?: number
  coalesceMs?: number
}

export function push<T>(h: History<T>, next: T, opts: PushOptions = {}): History<T> {
  if (Object.is(next, h.present)) return h
  const now = opts.now ?? Date.now()
  const window = opts.coalesceMs ?? 1000
  const label = opts.label ?? 'Edit'
  if (opts.key && opts.key === h.lastKey && now - h.lastAt <= window && h.past.length > 0) {
    // Replace the present; the step's "before" stays the one already in past.
    return { ...h, present: next, future: [], futureLabels: [], lastAt: now, presentLabel: label }
  }
  const past = [...h.past, h.present]
  const pastLabels = [...h.pastLabels, label]
  while (past.length > HISTORY_LIMIT) {
    past.shift()
    pastLabels.shift()
  }
  return {
    past, present: next, future: [], lastKey: opts.key ?? null, lastAt: now,
    pastLabels, futureLabels: [], presentLabel: label,
  }
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h
  const prev = h.past[h.past.length - 1]
  const label = h.pastLabels[h.pastLabels.length - 1] ?? 'Edit'
  return {
    past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future],
    pastLabels: h.pastLabels.slice(0, -1), futureLabels: [label, ...h.futureLabels],
    lastKey: null, lastAt: 0, presentLabel: '',
  }
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h
  const [next, ...rest] = h.future
  const [label, ...restLabels] = h.futureLabels
  return {
    past: [...h.past, h.present], present: next, future: rest,
    pastLabels: [...h.pastLabels, label ?? 'Edit'], futureLabels: restLabels,
    lastKey: null, lastAt: 0, presentLabel: label ?? 'Edit',
  }
}

/** Label of the step `undo` would revert, for "Undo <label>". */
export function undoLabel<T>(h: History<T>): string | null {
  return h.pastLabels.length ? h.pastLabels[h.pastLabels.length - 1] : null
}

export function redoLabel<T>(h: History<T>): string | null {
  return h.futureLabels.length ? h.futureLabels[0] : null
}

/** Ends coalescing so the next push is its own step (e.g. when a dialog closes). */
export function seal<T>(h: History<T>): History<T> {
  return h.lastKey ? { ...h, lastKey: null } : h
}

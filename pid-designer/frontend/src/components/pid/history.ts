import { useCallback, useEffect, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { toStored } from '../../api/diagrams';

/**
 * Undo and redo.
 *
 * History is a list of the drawing as it is *saved* -- `toStored`, so a
 * selection, a drag flag or a re-measure never costs an undo step -- kept as
 * text, which is both the comparison and a copy nothing can mutate later.
 *
 * Three rules, each learned from a way undo used to lose work:
 *
 * - **The drawing as opened is the floor.** History used to start from an
 *   empty drawing and record the load on top of it as if it were an edit, so
 *   one Ctrl+Z too many -- or a held Ctrl+Z -- blanked the canvas, and the
 *   autosave then wrote the blank over the working copy. `reset` makes the
 *   loaded drawing the only entry. An import or a restore from a version is
 *   an edit like any other and stays undoable; only opening resets. And the
 *   empty canvas a history starts on is not a step either: until something
 *   resets it, the first drawing recorded takes its place rather than going
 *   on top of it, so no path that forgets to reset can undo into a blank.
 *
 * - **Undo and redo record what is pending first.** An entry is recorded
 *   300 ms after the drawing stops changing, so the last edit before a quick
 *   Ctrl+Z was not on the list yet: the press stepped back past it, taking the
 *   edit before it too, and the edit itself could never be redone.
 *
 * - **A correction is not an edit.** The designer puts tees back on their
 *   pipes after a change (the reseat), and a restored drawing can need that
 *   too -- it may have been recorded before a turned symbol's ports were
 *   re-measured. That correction used to be recorded as a new edit on top of
 *   the entry just restored, which put the edit being undone straight back
 *   and threw redo away: Ctrl+Z became a permanent no-op. `correct` marks a
 *   change as the reseat's own, and when nothing but corrections separates
 *   the drawing from the current entry, the settled drawing *replaces* that
 *   entry instead of being pushed on top of it.
 *
 * The rules are a pure reducer, `historyReducer`, so they can be tested
 * without React; `useHistory` wires it to the canvas.
 */

export const MAX_HISTORY = 100;

/** How long the drawing has to stay still before a change is an entry. */
export const HISTORY_DEBOUNCE_MS = 300;

export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

/** The drawing as history keeps and compares it: what would be saved, as text. */
export const storedText = (g: Graph): string => JSON.stringify(toStored(g));

export interface History {
  /** Each entry is `storedText` of the drawing at that step. */
  readonly entries: readonly string[];
  readonly index: number;
  /**
   * The current entry as the reseat has corrected it since, while nothing
   * else has changed. A recorded drawing equal to this is a correction of the
   * current entry, not an edit on top of it.
   */
  readonly settled: string;
  /**
   * Something other than a correction has changed since the last entry. Once
   * it is known, later corrections cannot make the drawing a mere correction
   * again, and the text comparisons they would cost are skipped -- during a
   * drag every tick is corrected.
   */
  readonly edited: boolean;
  /**
   * The only entry is the canvas as it was mounted, before any drawing
   * arrived. Nobody drew that, so it is not somewhere undo can go back to.
   */
  readonly provisional: boolean;
}

export type HistoryAction =
  /** The drawing has been still for a while: make it an entry if it is new. */
  | { type: 'record'; graph: Graph }
  /** The reseat turned `before` into `after`; nothing else did anything. */
  | { type: 'correct'; before: Graph; after: Graph }
  | { type: 'undo' }
  | { type: 'redo' }
  /** A drawing was opened: it is the whole history now. */
  | { type: 'reset'; graph: Graph };

const EMPTY: Graph = { nodes: [], edges: [] };

/**
 * A history whose only entry is `graph`. Without one it starts on the empty
 * canvas, provisionally: see `provisional`.
 */
export function startHistory(graph?: Graph): History {
  const text = storedText(graph ?? EMPTY);
  return { entries: [text], index: 0, settled: text, edited: false, provisional: !graph };
}

/** The drawing at the current step, as fresh objects. */
export function currentGraph(h: History): Graph {
  return JSON.parse(h.entries[h.index]) as Graph;
}

/**
 * The history after `action`. Returns `h` itself when nothing changes, so a
 * caller can tell an undo with nowhere to go from one that went somewhere.
 */
export function historyReducer(h: History, action: HistoryAction): History {
  switch (action.type) {
    case 'record': {
      const text = storedText(action.graph);
      const current = h.entries[h.index];
      // Back where the entry was: whatever was edited has been undone by
      // hand. What the reseat has settled stays settled -- its corrected
      // drawing may simply not have rendered yet.
      if (text === current) return h.edited ? { ...h, edited: false } : h;
      // The first drawing on a canvas nothing reset: it is the floor.
      if (h.provisional) return startHistory(action.graph);
      if (text === h.settled) {
        // Only the reseat has been at it: the settled drawing is what this
        // step always meant, so it takes the step's place. Redo is untouched.
        const entries = h.entries.slice();
        entries[h.index] = text;
        return { ...h, entries, edited: false };
      }
      const entries = [...h.entries.slice(0, h.index + 1), text];
      while (entries.length > MAX_HISTORY) entries.shift();
      return { entries, index: entries.length - 1, settled: text, edited: false, provisional: false };
    }
    case 'correct': {
      if (h.edited) return h;
      // What the reseat corrected has to be the entry, or the entry as it
      // was already corrected; anything else carries an edit of its own.
      const before = storedText(action.before);
      if (before !== h.settled && before !== h.entries[h.index]) return { ...h, edited: true };
      const settled = storedText(action.after);
      return settled === h.settled ? h : { ...h, settled };
    }
    case 'undo':
    case 'redo': {
      const index = h.index + (action.type === 'undo' ? -1 : 1);
      if (index < 0 || index >= h.entries.length) return h;
      return { ...h, index, settled: h.entries[index], edited: false };
    }
    case 'reset':
      return startHistory(action.graph);
  }
}

/**
 * Undo history for the canvas.
 *
 * Records the drawing `HISTORY_DEBOUNCE_MS` after it stops changing. Returns:
 * - `undo` / `redo`, which record anything pending first;
 * - `reset(graph)`, for the load: the opened drawing becomes the floor;
 * - `flush()`, to record what is pending now, for an operation about to
 *   replace the drawing wholesale (an import, a restore);
 * - `markCorrection(before, after)`, for the reseat to say that the change it
 *   is about to make is a correction of `before`, not an edit;
 * - `peek()`, the history as it stands.
 */
export function useHistory(
  nodes: Node[],
  edges: Edge[],
  setNodes: (nds: Node[]) => void,
  setEdges: (eds: Edge[]) => void,
) {
  const history = useRef<History>(startHistory());
  // What is on the canvas now. Recording reads it rather than a render's
  // closure, so a flush from undo records the drawing as it is at the press.
  const latest = useRef<Graph>({ nodes, edges });
  latest.current = { nodes, edges };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback((action: HistoryAction) => {
    history.current = historyReducer(history.current, action);
  }, []);

  const cancel = useCallback(() => {
    if (timer.current === null) return false;
    clearTimeout(timer.current);
    timer.current = null;
    return true;
  }, []);

  const flush = useCallback(() => {
    if (cancel()) dispatch({ type: 'record', graph: latest.current });
  }, [cancel, dispatch]);

  useEffect(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      dispatch({ type: 'record', graph: latest.current });
    }, HISTORY_DEBOUNCE_MS);
  }, [nodes, edges, cancel, dispatch]);

  // Nothing is recorded for a canvas that has gone.
  useEffect(() => () => { cancel(); }, [cancel]);

  const step = useCallback((type: 'undo' | 'redo') => {
    flush();
    const next = historyReducer(history.current, { type });
    if (next === history.current) return;
    history.current = next;
    // A restore is not an edit: once rendered it equals the entry it came
    // from, so the record it schedules finds nothing new, and redo survives.
    const g = currentGraph(next);
    setNodes(g.nodes);
    setEdges(g.edges);
  }, [flush, setNodes, setEdges]);

  const undo = useCallback(() => step('undo'), [step]);
  const redo = useCallback(() => step('redo'), [step]);

  const reset = useCallback((graph: Graph) => {
    // Whatever was waiting belongs to the canvas before the drawing arrived.
    cancel();
    dispatch({ type: 'reset', graph });
  }, [cancel, dispatch]);

  const markCorrection = useCallback((before: Graph, after: Graph) => {
    dispatch({ type: 'correct', before, after });
  }, [dispatch]);

  const peek = useCallback(() => history.current, []);

  return { undo, redo, reset, flush, markCorrection, peek };
}

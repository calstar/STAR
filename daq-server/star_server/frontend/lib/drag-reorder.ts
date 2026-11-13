/**
 * Drag-to-reorder for the config editor's ordered lists (tab bar, top-bar gauges, states).
 *
 * Native HTML5 drag and drop, no library. The drag starts only from a handle, so the inputs in a
 * row stay selectable and editable; the whole row is the drop target and the drag image. The handle
 * also takes ArrowUp / ArrowDown, so the list is still reorderable from the keyboard.
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import type { CsvGrid } from '@/lib/config-validation';

/** `arr` with the item at `from` moved to index `to` (the others shift to make room). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// Reorder a state-table grid's state columns (and, for transitions, the matching from-rows) to follow a new
// state order, so the table column order follows the state list when states are dragged. Only
// names in `order` move — among the slots they already hold — so a column the list does not name
// stays where it is.
export const reorderGridCols = (g: CsvGrid | null, order: string[], alsoRows: boolean): CsvGrid | null => {
  if (!g) return g;
  const rank = new Map(order.map((n, i) => [n, i] as const));
  const permutation = (names: string[]): number[] => {
    const slots = names.map((n, i) => (rank.has(n) ? i : -1)).filter((i) => i >= 0);
    const sorted = slots.slice().sort((a, b) => rank.get(names[a])! - rank.get(names[b])!);
    const perm = names.map((_, i) => i);
    slots.forEach((slot, k) => { perm[slot] = sorted[k]; });
    return perm;
  };
  const cols = permutation(g.states);
  let rows = g.rows.map((r) => ({ ...r, cells: cols.map((i) => r.cells[i]) }));
  if (alsoRows) {
    const rowPerm = permutation(rows.map((r) => r.key));
    rows = rowPerm.map((i) => rows[i]);
  }
  return { states: cols.map((i) => g.states[i]), rows };
};

/** Marks the element the handle's drag image is taken from (the row it reorders). */
export const DRAG_ROW_ATTR = 'data-drag-row';

/** The insertion line, drawn in the gap above (`before`) or below (`after`) a row. Positioned
 *  absolutely so showing it never moves the rows under the pointer. A block row gets a line with a
 *  dot at its left end, centred in the gap between rows; a table row draws it on its cells' edge,
 *  as rows in a table have no gap. */
const LINE_BLOCK =
  "relative before:content-[''] before:pointer-events-none before:absolute before:z-10 before:left-2 before:right-0 " +
  'before:h-[3px] before:rounded-full before:bg-blue-500 ' +
  "after:content-[''] after:pointer-events-none after:absolute after:z-10 after:left-0 after:h-[11px] after:w-[11px] " +
  'after:rounded-full after:border-[3px] after:border-blue-500 after:bg-background';
const LINE_BLOCK_BEFORE = `${LINE_BLOCK} before:-top-[7px] after:-top-[11px]`;
const LINE_BLOCK_AFTER = `${LINE_BLOCK} before:-bottom-[7px] after:-bottom-[11px]`;
const LINE_TABLE_BEFORE = '[&>td]:shadow-[inset_0_3px_0_0_#3b82f6]';
const LINE_TABLE_AFTER = '[&>td]:shadow-[inset_0_-3px_0_0_#3b82f6]';

export function useDragReorder(onMove: (from: number, to: number) => void, enabled = true) {
  // `gap` is where the item would be inserted: 0 = above the first row, n = below the last.
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  const clear = () => setDrag(null);
  /** Inserting at `gap` lands the item at this index once it has left its own slot. */
  const targetOf = (from: number, gap: number) => (gap > from ? gap - 1 : gap);

  const handleProps = (i: number, count: number) => ({
    draggable: enabled,
    tabIndex: enabled ? 0 : -1,
    role: 'button',
    'aria-label': 'Drag to reorder (or use the arrow keys)',
    title: enabled ? 'Drag to reorder' : undefined,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (!enabled) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag that carries no data.
      e.dataTransfer.setData('text/plain', String(i));
      const row = e.currentTarget.closest(`[${DRAG_ROW_ATTR}]`);
      if (row instanceof HTMLElement) e.dataTransfer.setDragImage(row, 16, 16);
      setDrag({ from: i, gap: i });
    },
    onDragEnd: clear,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!enabled) return;
      const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
      if (to === null) return;
      e.preventDefault();
      if (to >= 0 && to < count) onMove(i, to);
    },
  });

  const rowProps = (i: number) => ({
    [DRAG_ROW_ATTR]: '',
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag) return;            // a drag from somewhere else (a file, another list)
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Top half of a row inserts above it, bottom half below.
      const r = e.currentTarget.getBoundingClientRect();
      const gap = e.clientY < r.top + r.height / 2 ? i : i + 1;
      if (drag.gap !== gap) setDrag({ ...drag, gap });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();          // the list's own drop handler would move it a second time
      const to = targetOf(drag.from, drag.gap);
      if (to !== drag.from) onMove(drag.from, to);
      clear();
    },
  });

  /** For the element holding the rows: a drop in the space between two rows (which is the list's,
   *  not a row's) lands at the gap the line was last drawn in. */
  const listProps = () => ({
    onDragOver: (e: DragEvent<HTMLElement>) => { if (drag) e.preventDefault(); },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag) return;
      e.preventDefault();
      const to = targetOf(drag.from, drag.gap);
      if (to !== drag.from) onMove(drag.from, to);
      clear();
    },
  });

  /** Classes for row i (of `count`) while a drag is in flight: the dragged row dims, and the
   *  insertion line shows in the gap the row would drop into — not at all when that would leave
   *  it where it is. */
  const rowClass = (i: number, count: number, layout: 'block' | 'table' = 'block'): string => {
    if (!drag) return '';
    const parts: string[] = [];
    if (i === drag.from) parts.push('opacity-40');
    const noop = targetOf(drag.from, drag.gap) === drag.from;
    if (!noop) {
      if (drag.gap === i) parts.push(layout === 'table' ? LINE_TABLE_BEFORE : LINE_BLOCK_BEFORE);
      else if (drag.gap === count && i === count - 1) parts.push(layout === 'table' ? LINE_TABLE_AFTER : LINE_BLOCK_AFTER);
    }
    return parts.join(' ');
  };

  return { handleProps, rowProps, listProps, rowClass, dragging: drag !== null };
}

/** The handle glyph's classes, shared so every list's handle looks the same. */
export const DRAG_HANDLE_CLASS =
  'cursor-grab active:cursor-grabbing select-none px-1.5 text-text-muted hover:text-text ' +
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded';

/**
 * Drag an item from one list into another — a role row onto another board's panel. The item is
 * held in state (not dataTransfer, which a dragover cannot read), every panel that would take it
 * is outlined while the drag is in flight, and the one under the pointer is filled in.
 */
export function useTransferDrag<T>(
  accepts: (item: T, target: string) => boolean,
  onTransfer: (item: T, target: string) => void,
  enabled = true,
) {
  const [item, setItem] = useState<T | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const clear = () => { setItem(null); setOver(null); };

  const handleProps = (it: T) => ({
    draggable: enabled,
    role: 'button',
    'aria-label': 'Drag onto another board to move it there',
    title: enabled ? 'Drag onto another board to move it there' : undefined,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (!enabled) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'role');
      const row = e.currentTarget.closest(`[${DRAG_ROW_ATTR}]`);
      if (row instanceof HTMLElement) e.dataTransfer.setDragImage(row, 16, 16);
      setItem(it);
    },
    onDragEnd: clear,
  });

  const panelProps = (target: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (item === null || !accepts(item, target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== target) setOver(target);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (over === target && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (item === null || !accepts(item, target)) return;
      e.preventDefault();
      const it = item;
      clear();
      onTransfer(it, target);
    },
  });

  /** '' when nothing is being dragged; outlined when this panel would take the item, filled in
   *  when the pointer is over it, dimmed when it would not. */
  const panelState = (target: string): '' | 'accepts' | 'over' | 'refuses' => {
    if (item === null) return '';
    if (!accepts(item, target)) return 'refuses';
    return over === target ? 'over' : 'accepts';
  };

  return { handleProps, panelProps, panelState, dragging: item };
}

/** Panel classes for each useTransferDrag panelState. */
export const TRANSFER_PANEL_CLASS: Record<'' | 'accepts' | 'over' | 'refuses', string> = {
  '': 'border border-transparent',
  accepts: 'border border-dashed border-blue-500/60',
  over: 'border border-blue-500 bg-blue-500/10',
  refuses: 'border border-transparent opacity-50',
};

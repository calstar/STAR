'use client'

/**
 * The Config page's editors for the main page's layout: the actuator tiles' order (Roles tab) and
 * where each state sits on the state grid (State Machine tab). Both edit the config being drafted;
 * nothing changes on the main page until it is saved. See lib/panel-layout.ts for where each
 * setting lives in config.toml.
 *
 * While a tile is dragged the grid shows the drop's result live — the others slide out of the way
 * to where they would land — and letting go off the grid puts everything back. Drag and drop is
 * the browser's own (HTML5 DnD), so there is no dependency to add.
 *
 * Every tile is a direct child of one CSS grid, keyed by what it shows, and moves only by its
 * grid-row / grid-column. Its DOM node never moves or remounts mid-drag: a drag whose source node
 * is detached never gets its dragend, which would leave the preview stuck.
 *
 * THE TARGET is the fixed place under the cursor (an actuator slot, a state cell, the tray), never
 * a tile. While a drag is on, every tile has pointer-events: none, so the browser hit-tests the
 * places beneath. Targeting the tile under the cursor was a feedback loop: a tile mid-slide is
 * drawn where it used to be, the cursor "lands" on it, the preview moves it back, it slides again
 * — a held tile swapped back and forth ~20 times before settling. The places never move, so the
 * target is a function of the cursor alone. __tests__/panel-layout.test.tsx holds a tile still and
 * hit-tests a frame behind the layout to keep it that way.
 *
 * The state table's Row / Col fields stay as the precise way in.
 */

import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import { moveItem, placedExtent, type GridCell, type GridSize } from '@/lib/panel-layout';

/** The main page draws a 4 x 4 grid of actuator tiles; a role past the 16th is not shown. */
export const MAIN_PAGE_ACTUATOR_SLOTS = 16;
const ACTUATOR_COLS = 4;

const MIME = 'text/plain'; // Firefox starts a drag only once dataTransfer has data
const SLIDE = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';

/**
 * Slide every `[data-flip]` child of `container` from where it was drawn last render to where it is
 * now (FLIP: measure, invert with a transform, play the transform back to zero). Positions are
 * relative to the container, so scrolling the page mid-drag animates nothing.
 */
function useSlide(container: RefObject<HTMLElement>) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const now = new Map<string, { x: number; y: number }>();
    root.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
      // Measure where it lays out, not where a half-played slide has it.
      el.style.transition = 'none';
      el.style.transform = '';
      const r = el.getBoundingClientRect();
      const pos = { x: r.left - origin.left, y: r.top - origin.top };
      now.set(el.dataset.flip!, pos);
      const was = last.current.get(el.dataset.flip!);
      if (!was || (was.x === pos.x && was.y === pos.y)) return;
      el.style.transform = `translate(${was.x - pos.x}px, ${was.y - pos.y}px)`;
      void el.offsetWidth; // commit the inverted position before animating out of it
      el.style.transition = SLIDE;
      el.style.transform = '';
    });
    last.current = now;
  });
}

/**
 * One drag at a time: which item is held (`from`) and which slot it is over (`over`). `over` is
 * null off the grid, so the preview shows the layout as it stands.
 */
function useDragPreview<Slot>() {
  const [drag, setDrag] = useState<{ from: number; over: Slot | null } | null>(null);
  const start = (from: number) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(MIME, String(from));
    // Next tick: the browser snapshots the drag image after this handler, and the held tile's
    // dimmed look would otherwise be what follows the cursor.
    window.setTimeout(() => setDrag({ from, over: null }), 0);
  };
  const hover = (slot: Slot, same: (a: Slot, b: Slot) => boolean) => (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drag.over === null || !same(drag.over, slot)) setDrag({ ...drag, over: slot });
  };
  /** Leaving the grid itself (not just moving between its tiles) shows the layout unchanged. */
  const leave = (container: RefObject<HTMLElement>) => (e: DragEvent) => {
    const to = e.relatedTarget as Node | null;
    if (drag && (!to || !container.current?.contains(to))) setDrag({ ...drag, over: null });
  };
  const end = () => setDrag(null);
  return { drag, start, hover, leave, end };
}

// ── Actuators ────────────────────────────────────────────────────────────────

export interface ActuatorTile {
  name: string;
  channel: number;
  entity: string;
  boardId?: number;
  ballValve?: boolean;
}

/** The grid row (1-based) of the tile at `pos`: the 16 main-page places, a label row, the rest. */
const actuatorRow = (pos: number) =>
  Math.floor(pos / ACTUATOR_COLS) + 1 + (pos >= MAIN_PAGE_ACTUATOR_SLOTS ? 1 : 0);
const at = (row: number, col: number) => ({ gridRow: row, gridColumn: col });

/**
 * The main page's actuator grid, in the order it will be drawn. Drag a tile over another's place
 * and the rest make room; let go to keep it. `onReorder` receives every name in the new order.
 */
export function ActuatorLayoutEditor({ tiles, onReorder, disabled = false }: {
  tiles: ActuatorTile[];
  onReorder: (names: string[]) => void;
  disabled?: boolean;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const { drag, start, hover, leave, end } = useDragPreview<number>();
  useSlide(grid);

  const n = tiles.length;
  const order = tiles.map((_, i) => i);
  const shown = drag && drag.over !== null ? moveItem(order, drag.from, drag.over) : order;
  const posOf = new Map(shown.map((tileIdx, pos) => [tileIdx, pos]));
  const slots = Math.max(MAIN_PAGE_ACTUATOR_SLOTS, n);
  const same = (a: number, b: number) => a === b;

  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && drag.over !== null && drag.over !== drag.from)
      onReorder(moveItem(tiles.map((t) => t.name), drag.from, drag.over));
    end();
  };

  return (
    <div
      ref={grid}
      data-testid="actuator-layout-grid"
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${ACTUATOR_COLS}, minmax(0, 1fr))`, gridAutoRows: '4rem' }}
      onDragLeave={leave(grid)}
      onDrop={drop}
    >
      {/* The places themselves: a drop target under every tile, dashed where nothing sits. An
          empty place past the last tile means "the end". */}
      {Array.from({ length: slots }, (_, pos) => (
        <div
          key={`slot:${pos}`}
          onDragOver={hover(Math.min(pos, n - 1), same)}
          style={at(actuatorRow(pos), (pos % ACTUATOR_COLS) + 1)}
          className={pos >= n ? 'border border-dashed border-gray-700' : ''}
        />
      ))}
      {n > MAIN_PAGE_ACTUATOR_SLOTS && (
        <p className="self-end text-sm text-yellow-400" style={{ gridRow: actuatorRow(MAIN_PAGE_ACTUATOR_SLOTS) - 1, gridColumn: '1 / -1' }}>
          Not on the main page (it has {MAIN_PAGE_ACTUATOR_SLOTS} places) — drag one into the grid to show it:
        </p>
      )}
      {tiles.map((t, i) => {
        const pos = posOf.get(i)!;
        const held = drag?.from === i;
        return (
          <div
            key={`tile:${t.name}`}
            data-flip={`tile:${t.name}`}
            data-testid={`actuator-layout-tile:${t.name}`}
            data-pos={pos}
            draggable={!disabled}
            onDragStart={start(i)}
            onDragEnd={end}
            title={disabled ? t.name : `${t.name} — drag to move`}
            // Mid-drag, tiles are invisible to the pointer so the target is the fixed place under
            // the cursor (see THE TARGET below), never a tile that is still sliding through it.
            style={{ ...at(actuatorRow(pos), (pos % ACTUATOR_COLS) + 1), ...(drag ? { pointerEvents: 'none' } : {}) }}
            className={`min-w-0 ${disabled ? '' : 'cursor-grab active:cursor-grabbing'} ${held ? 'opacity-40' : ''}`}
          >
            {/* The live tile, display only: the wrapper takes every pointer event, and `preview`
                makes sure it could not send a command even if one reached it. */}
            <div className="pointer-events-none h-full">
              <ActuatorControlByName {...t} preview />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

export interface GridState {
  name?: string;
  panel_row?: number;
  panel_col?: number;
  is_abort?: boolean;
}

/** A state's new place: a cell, or null to take it off the diagram. */
export type Placement = { idx: number; cell: GridCell | null };

/** Where a held state is: over a cell, or over the off-diagram tray. */
type StateSlot = GridCell | 'tray';

const MAX_GRID = 12;
const cellOf = (s: GridState): GridCell | null =>
  typeof s.panel_row === 'number' && typeof s.panel_col === 'number' ? { row: s.panel_row, col: s.panel_col } : null;
const sameSlot = (a: StateSlot, b: StateSlot) =>
  a === 'tray' || b === 'tray' ? a === b : a.row === b.row && a.col === b.col;

/**
 * What dropping state `from` on `slot` does: onto an empty cell it moves there; onto another
 * state the two swap (the other takes the held one's old place, or leaves the diagram if it had
 * none); onto the tray it leaves the diagram.
 */
function placementsFor(states: GridState[], from: number, slot: StateSlot): Placement[] {
  if (slot === 'tray') return cellOf(states[from]) ? [{ idx: from, cell: null }] : [];
  const occupant = states.findIndex((s) => {
    const c = cellOf(s);
    return c !== null && c.row === slot.row && c.col === slot.col;
  });
  if (occupant === from) return [];
  const moves: Placement[] = [{ idx: from, cell: slot }];
  if (occupant >= 0) moves.push({ idx: occupant, cell: cellOf(states[from]) });
  return moves;
}

function applyPlacements(states: GridState[], moves: Placement[]): GridState[] {
  const out = states.slice();
  for (const { idx, cell } of moves)
    out[idx] = { ...out[idx], panel_row: cell?.row, panel_col: cell?.col };
  return out;
}

/**
 * The state diagram's grid. Drag a state onto an empty cell to move it there, onto another state
 * to swap the two, or onto the tray to take it off the diagram — the grid shows the result while
 * you hold it. The row / column buttons resize the grid, never below what the placed states need.
 */
export function StateGridEditor({ states, size, onPlace, onResize, disabled = false }: {
  states: GridState[];
  size: GridSize;
  /** Every state that moves in one gesture (a swap moves two). */
  onPlace: (moves: Placement[]) => void;
  onResize: (size: GridSize) => void;
  disabled?: boolean;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const { drag, start, hover, leave, end } = useDragPreview<StateSlot>();
  useSlide(grid);

  const ext = placedExtent(states);
  const shownStates = drag && drag.over !== null ? applyPlacements(states, placementsFor(states, drag.from, drag.over)) : states;
  const rows = Math.max(1, size.rows);
  const cols = Math.max(1, size.cols);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && drag.over !== null) {
      const moves = placementsFor(states, drag.from, drag.over);
      if (moves.length) onPlace(moves);
    }
    end();
  };

  // The tray: a label row, then the off-diagram states in the grid's own columns.
  const unplaced = shownStates.map((s, i) => [s, i] as const).filter(([s]) => !cellOf(s));
  const trayRow = rows + 1;
  const trayRows = Math.max(1, Math.ceil(unplaced.length / cols));
  const trayPos = new Map(unplaced.map(([, i], k) => [i, { row: trayRow + 1 + Math.floor(k / cols), col: (k % cols) + 1 }]));

  const stepper = (label: string, value: number, min: number, set: (v: number) => void) => (
    <span className="flex items-center gap-1 text-sm">
      <span className="text-text-muted mr-1">{label}</span>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={disabled || value <= Math.max(1, min)}
        onClick={() => set(value - 1)} className="px-2 py-0.5 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-30">−</button>
      <span className="w-6 text-center font-mono" data-testid={`state-grid-${label.toLowerCase()}`}>{value}</span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={disabled || value >= MAX_GRID}
        onClick={() => set(value + 1)} className="px-2 py-0.5 bg-gray-700 rounded hover:bg-gray-600 disabled:opacity-30">+</button>
    </span>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        {stepper('Rows', rows, ext.rows, (r) => onResize({ rows: r, cols }))}
        {stepper('Columns', cols, ext.cols, (c) => onResize({ rows, cols: c }))}
      </div>
      <div className="overflow-x-auto">
        <div
          ref={grid}
          data-testid="state-layout-grid"
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(7rem, 1fr))`, gridAutoRows: '3rem' }}
          onDragLeave={leave(grid)}
          onDrop={drop}
        >
          {Array.from({ length: rows * cols }, (_, k) => {
            const cell = { row: Math.floor(k / cols), col: k % cols };
            const key = `${cell.row}:${cell.col}`;
            return (
              <div
                key={`cell:${key}`}
                data-testid={`state-layout-cell:${key}`}
                onDragOver={hover(cell, sameSlot)}
                style={at(cell.row + 1, cell.col + 1)}
                className="border border-dashed border-gray-700"
              />
            );
          })}

          <div
            data-testid="state-layout-tray"
            onDragOver={hover('tray', sameSlot)}
            style={{ gridRow: `${trayRow} / span ${trayRows + 1}`, gridColumn: '1 / -1' }}
            className={`border border-dashed p-2 ${drag?.over === 'tray' ? 'border-blue-400' : 'border-gray-700'}`}
          >
            <p className="text-xs text-text-muted">Not on the diagram — drag a state here to take it off, or from here onto a cell.</p>
          </div>

          {shownStates.map((s, i) => {
            const c = cellOf(s);
            const place = c ? at(c.row + 1, c.col + 1) : (() => { const t = trayPos.get(i)!; return at(t.row, t.col); })();
            const held = drag?.from === i;
            const label = states[i].name;
            return (
              <div
                key={`state:${i}`}
                data-flip={`state:${i}`}
                data-testid={`state-layout-tile:${label ?? i}`}
                draggable={!disabled}
                onDragStart={start(i)}
                onDragEnd={end}
                title={s.is_abort ? `${label} — an abort: placed, but the main page does not draw it` : label}
                // Mid-drag the cell or tray under the cursor is the target, never a sliding state
                // (THE TARGET, top of file).
                style={{ ...place, ...(c ? {} : { margin: '0 0.5rem 0.5rem' }), ...(drag ? { pointerEvents: 'none' } : {}) }}
                className={`flex items-center justify-center truncate border px-2 text-center font-mono text-xs uppercase tracking-[0.1em]
                  ${s.is_abort ? 'border-red-500/70 text-red-400' : 'border-gray-500 text-white'} bg-gray-800
                  ${disabled ? '' : 'cursor-grab active:cursor-grabbing'} ${held ? 'opacity-40' : ''}`}
              >
                {label || `#${i}`}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Main-page layout chosen on the Config page: the order of the actuator tiles and the size of the
 * state-machine grid. Both live in config.toml [gui]:
 *
 *   actuator_order  = ["Fuel Main", "LOX Main", ...]   # tile order on the main page
 *   state_grid_rows = 6                                # state grid size (cells), at least the
 *   state_grid_cols = 5                                # extent of the placed states
 *
 * They sit in [gui] rather than in the order of [actuator_roles] / [[states]] because Save
 * re-sorts actuator_roles by board and channel (sortRolesForSave), and the order of [[states]]
 * is the column order of the state CSVs.
 *
 * Absent keys mean the previous behaviour, exactly: tiles in actuator_roles file order, and a grid
 * just big enough for the placed states.
 */

/**
 * Names in display order: the names `order` lists (in its order), then every other name in its
 * original order. Names in `order` that no longer exist are skipped, so a removed or renamed role
 * leaves no gap.
 */
export function orderByNames(names: string[], order: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(order) || order.length === 0) return names.slice();
  const present = new Set(names);
  const seen = new Set<string>();
  const head: string[] = [];
  for (const n of order) {
    if (typeof n !== 'string' || !present.has(n) || seen.has(n)) continue;
    seen.add(n);
    head.push(n);
  }
  return [...head, ...names.filter((n) => !seen.has(n))];
}

/** Move the item at `from` to index `to` (the slot it is dropped on). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export interface GridCell { row: number; col: number }
export interface GridSize { rows: number; cols: number }

type Placeable = { panel_row?: number | null; panel_col?: number | null };

const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Smallest grid that holds every placed state (0 x 0 when none is placed). */
export function placedExtent(states: readonly Placeable[]): GridSize {
  let rows = 0, cols = 0;
  for (const s of states) {
    if (!isCoord(s.panel_row) || !isCoord(s.panel_col)) continue;
    rows = Math.max(rows, s.panel_row + 1);
    cols = Math.max(cols, s.panel_col + 1);
  }
  return { rows, cols };
}

/** A positive integer from [gui], or undefined when it is absent or not one. */
function gridDim(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;
}

/**
 * The state grid's size: the configured [gui] state_grid_rows / state_grid_cols, never smaller than
 * what the placed states need. With neither configured it is the extent of the placed states — the
 * diagram as it was sized before the setting existed.
 */
export function stateGridSize(
  states: readonly Placeable[],
  gui: { state_grid_rows?: unknown; state_grid_cols?: unknown } | undefined | null,
): GridSize {
  const ext = placedExtent(states);
  return {
    rows: Math.max(ext.rows, gridDim(gui?.state_grid_rows) ?? 0),
    cols: Math.max(ext.cols, gridDim(gui?.state_grid_cols) ?? 0),
  };
}

/**
 * The first empty cell of a rows x cols grid, row by row, or undefined if every cell is taken.
 */
export function firstFreeCell(states: readonly Placeable[], size: GridSize): GridCell | undefined {
  const used = new Set(
    states.filter((s) => isCoord(s.panel_row) && isCoord(s.panel_col)).map((s) => `${s.panel_row}:${s.panel_col}`),
  );
  for (let row = 0; row < size.rows; row++)
    for (let col = 0; col < size.cols; col++)
      if (!used.has(`${row}:${col}`)) return { row, col };
  return undefined;
}

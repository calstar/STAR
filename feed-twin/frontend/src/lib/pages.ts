/**
 * A panel split by the drawing's sheets.
 *
 * A stand drawn as Rocket and GSE lists both sides' valves in one panel menu,
 * and the operator has to know which is which by name. Grouped by page, the
 * ⋯ checklist reads the way the drawing does, a small heading a sheet. The
 * panels themselves stay one list.
 *
 * Only when the panel's items span more than one page: a one-sheet stand
 * gets one group and no headings, exactly as before.
 */

export interface Group<T> {
  /** The page's name, or null when there is only one and nothing to split. */
  page: string | null;
  items: T[];
}

/** What an item not on the drawing (the engine's own chamber channel) is filed under. */
export const OFF_DRAWING = 'Other';

export function groupByPage<T>(
  all: T[],
  shown: T[],
  idOf: (item: T) => string,
  pages: Record<string, string> | undefined,
): Group<T>[] {
  const pageOf = (item: T) => pages?.[idOf(item)] ?? OFF_DRAWING;
  // In the drawing's own order: the order its nodes come in.
  const order = [...new Set(Object.values(pages ?? {}))];
  const present = new Set(all.map(pageOf));
  if (present.size <= 1) return [{ page: null, items: shown }];
  const rank = (p: string) => (p === OFF_DRAWING ? Infinity : order.indexOf(p));
  return [...present]
    .sort((a, b) => rank(a) - rank(b))
    .map((page) => ({ page, items: shown.filter((i) => pageOf(i) === page) }));
}

import { DEFAULT_PAGE, pageOf } from '@pid/pages';

/** The page the burn flies: the vehicle's, the one holding the ENGINE (its drawn-line component is
 *  the vehicle; feedtwin.pid.roles). A two-page Rocket + GSE drawing's GSE page holds most of the
 *  symbols, and picking by count put the ground cart in the Feed system card. With no engine drawn
 *  it falls back to the page holding most of the drawing. */
export function vehiclePage(nodes: readonly { data?: unknown }[]): string {
  const count = new Map<string, number>();
  for (const n of nodes) {
    const d = (n.data ?? {}) as { page?: string; componentType?: string };
    const p = pageOf(d);
    if (d.componentType === 'ENGINE') return p;
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best = DEFAULT_PAGE;
  for (const [p, c] of count) if (c > (count.get(best) ?? 0)) best = p;
  return best;
}

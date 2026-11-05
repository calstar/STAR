import type { DocMeta, DocRef } from '../api/documents';
import { keyOf, refOf } from '../api/documents';

/**
 * Which design a browser opens when it has no say of its own.
 *
 * It used to be "your first design in the list". The list is in creation order, so on the team's
 * machine that was "Design 1" -- the default-named draft seeded from configs/default.yaml (methalox)
 * and untouched since September -- while the design everyone works on, the ethalox doublet, sat
 * second. A fresh browser opened a methalox engine nobody was designing.
 *
 * Now, in order: the design this browser had open, the team's main design (an app that marks one),
 * the one of your own changed most recently, then the most recently changed of any. Pure, so the
 * order is tested rather than remembered.
 */
export function pickInitialDesign(docs: DocMeta[], remembered: DocRef | null): DocMeta | null {
  if (docs.length === 0) return null;
  if (remembered) {
    const match = docs.find((d) => keyOf(refOf(d)) === keyOf(remembered));
    if (match) return match;
  }
  const featured = docs.find((d) => d.featured);
  if (featured) return featured;
  const newest = (list: DocMeta[]) =>
    list.reduce<DocMeta | null>((best, d) => (!best || stamp(d) > stamp(best) ? d : best), null);
  // `mine` is absent on an older server, which only ever listed your own designs.
  return newest(docs.filter((d) => d.mine !== false)) ?? newest(docs);
}

function stamp(d: DocMeta): number {
  const t = Date.parse(d.updatedAt || d.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

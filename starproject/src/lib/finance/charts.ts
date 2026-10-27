import { UNTAGGED, type SpendingRow } from "@/lib/finance/ledger";

// What the Finance tab's charts draw, worked out apart from the drawing so it is tested.

/** Categorical colour slots the palette validates; an entity past them folds into Other. */
export const PIE_SLOTS = 6;
/** Named slices at most, so a pie stays part-to-whole at a glance (≤ 6 segments with Other and Not tagged). */
export const PIE_NAMED = 4;

export type PieSlice = {
  key: string;
  name: string;
  cents: number;
  /** A colour slot (0-based), or the neutral "other" / "untagged". */
  color: number | "other" | "untagged";
};

/**
 * A pie of one breakdown's top-level rows. Each entity keeps the colour of its place
 * in `order`, whichever year is shown; the biggest few get a slice, the rest fold
 * into Other, and untagged spend is its own grey slice last.
 */
export function pieSlices(rows: SpendingRow[], order: string[]): PieSlice[] {
  const size = (r: SpendingRow) => r.bucket.paidCents + r.bucket.pendingCents;
  const top = rows.filter((r) => r.depth === 0 && r.id && size(r) > 0);
  const named = top
    .filter((r) => {
      const i = order.indexOf(r.id!);
      return i >= 0 && i < PIE_SLOTS;
    })
    .sort((a, b) => size(b) - size(a))
    .slice(0, PIE_NAMED);
  const slices: PieSlice[] = named.map((r) => ({ key: r.id!, name: r.name, cents: size(r), color: order.indexOf(r.id!) }));

  const rest = top.filter((r) => !named.includes(r));
  const restCents = rest.reduce((s, r) => s + size(r), 0);
  if (restCents > 0) slices.push({ key: "other", name: `Other (${rest.length})`, cents: restCents, color: "other" });

  const untagged = rows.find((r) => r.id === null);
  if (untagged && size(untagged) > 0) slices.push({ key: "untagged", name: UNTAGGED, cents: size(untagged), color: "untagged" });
  return slices;
}

/** A round axis top and step for a column chart: 3–5 gridlines at 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceAxis(maxCents: number): { top: number; step: number } {
  if (maxCents <= 0) return { top: 10_000, step: 2_500 };
  const rough = maxCents / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough)!;
  return { top: Math.ceil(maxCents / step) * step, step };
}

/** Axis labels: $0, $500, $1.5k, $12k. */
export function compactDollars(cents: number): string {
  const d = cents / 100;
  if (d < 1000) return `$${Math.round(d)}`;
  const k = d / 1000;
  return `$${Number.isInteger(k) ? k : k.toFixed(k < 10 ? 1 : 0)}k`;
}

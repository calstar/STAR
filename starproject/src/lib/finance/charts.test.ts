import { describe, expect, it } from "vitest";

import { compactDollars, niceAxis, pieSlices } from "@/lib/finance/charts";
import { UNTAGGED, type SpendingRow } from "@/lib/finance/ledger";

const r = (id: string | null, name: string, cents: number, depth = 0): SpendingRow => ({
  id,
  name,
  depth,
  bucket: { paidCents: cents, pendingCents: 0, count: 1 },
});

describe("pieSlices", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g"];

  it("colours by place in the fixed order, not by size, and leaves subprojects out", () => {
    const s = pieSlices([r("b", "B", 100), r("b1", "B child", 60, 1), r("a", "A", 50), r(null, UNTAGGED, 10)], order);
    expect(s.map((x) => [x.key, x.cents, x.color])).toEqual([
      ["b", 100, 1],
      ["a", 50, 0],
      ["untagged", 10, "untagged"],
    ]);
  });

  it("keeps the biggest four and folds the rest, and anything past the palette, into Other", () => {
    const rows = [r("a", "A", 10), r("b", "B", 60), r("c", "C", 50), r("d", "D", 40), r("e", "E", 30), r("g", "G", 999)];
    const s = pieSlices(rows, order);
    expect(s.map((x) => x.key)).toEqual(["b", "c", "d", "e", "other"]);
    expect(s.at(-1)).toMatchObject({ name: "Other (2)", cents: 10 + 999, color: "other" });
  });

  it("skips empty rows", () => {
    expect(pieSlices([r("a", "A", 0), r(null, UNTAGGED, 0)], order)).toEqual([]);
  });
});

describe("niceAxis", () => {
  it("rounds the top up to a whole step", () => {
    expect(niceAxis(112_050)).toEqual({ top: 150_000, step: 50_000 });
    expect(niceAxis(9_000)).toEqual({ top: 10_000, step: 2_500 });
    expect(niceAxis(0).top).toBeGreaterThan(0);
  });
});

describe("compactDollars", () => {
  it("shortens thousands", () => {
    expect(compactDollars(50_000)).toBe("$500");
    expect(compactDollars(150_000)).toBe("$1.5k");
    expect(compactDollars(1_200_000)).toBe("$12k");
  });
});

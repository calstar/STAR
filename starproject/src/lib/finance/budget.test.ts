import { describe, expect, it } from "vitest";

import {
  budgetFor,
  budgetLineInputSchema,
  budgetProblem,
  remainingCents,
  requestSpend,
  type BudgetLineIn,
  type BudgetRequestIn,
} from "@/lib/finance/budget";

const line = (id: string, subteamId: string, plannedCents: number, projectId: string | null = null): BudgetLineIn => ({
  id,
  subteamId,
  projectId,
  name: id,
  plannedCents,
  note: null,
});

const req = (
  status: BudgetRequestIn["status"],
  budgetLineId: string | null,
  items: [number, boolean | null][],
  createdAt = "2026-10-10T12:00:00Z",
): BudgetRequestIn => ({
  status,
  budgetLineId,
  subteamId: null,
  createdAt,
  items: items.map(([predictedCents, approved]) => ({ predictedCents, approved })),
});

const subteams = [
  { id: "av", name: "Avionics", color: null },
  { id: "pr", name: "Propulsion", color: null },
  { id: "aa", name: "Aero", color: null },
];

describe("requestSpend", () => {
  it("counts only the lines a PVP approved", () => {
    expect(requestSpend(req("approved", "x", [[100, true], [50, false]]))).toEqual({ approvedCents: 100, pendingCents: 0 });
  });

  it("counts a waiting request as pending, all of it", () => {
    expect(requestSpend(req("pending", "x", [[100, null], [50, null]]))).toEqual({ approvedCents: 0, pendingCents: 150 });
  });

  it("counts nothing for rejected or cancelled requests", () => {
    expect(requestSpend(req("rejected", "x", [[100, false]]))).toEqual({ approvedCents: 0, pendingCents: 0 });
    expect(requestSpend(req("cancelled", "x", [[100, null]]))).toEqual({ approvedCents: 0, pendingCents: 0 });
  });

  it("counts every line of a request approved before per-line decisions", () => {
    expect(requestSpend(req("approved", "x", [[100, null], [25, null]]))).toEqual({ approvedCents: 125, pendingCents: 0 });
  });
});

describe("budgetFor", () => {
  const lines = [line("boards", "av", 100_000, "le4"), line("cables", "av", 20_000), line("plumbing", "pr", 300_000)];
  const requests = [
    req("approved", "boards", [[60_000, true], [10_000, false]]),
    req("pending", "boards", [[30_000, null]]),
    req("approved", "cables", [[25_000, true]]),
    req("rejected", "plumbing", [[999_00, false]]),
    req("approved", "someone-elses-year", [[1_000, true]]),
    req("approved", null, [[4_000, true]]),
    req("approved", null, [[8_000, true]], "2025-12-01T12:00:00Z"),
  ];
  const b = budgetFor(2026, lines, requests, subteams, (id) => (id === "le4" ? "LE4" : null));

  it("totals each line from the requests that name it", () => {
    const av = b.subteams.find((s) => s.id === "av")!;
    expect(av.lines.map((l) => [l.id, l.tally.approvedCents, l.tally.pendingCents, l.tally.requests])).toEqual([
      ["boards", 60_000, 30_000, 2],
      ["cables", 25_000, 0, 1],
    ]);
    expect(av.lines[0].projectLabel).toBe("LE4");
    expect(av.tally).toEqual({ plannedCents: 120_000, approvedCents: 85_000, pendingCents: 30_000, requests: 3 });
  });

  it("shows a line gone over as negative remaining", () => {
    const cables = b.subteams.find((s) => s.id === "av")!.lines[1];
    expect(remainingCents(cables.tally)).toBe(-5_000);
  });

  it("lists budgeted subteams biggest first, then the rest", () => {
    expect(b.subteams.map((s) => s.id)).toEqual(["pr", "av", "aa"]);
    expect(b.subteams[2].lines).toEqual([]);
  });

  it("totals the year, ignoring lines from other years", () => {
    expect(b.total).toEqual({ plannedCents: 420_000, approvedCents: 85_000, pendingCents: 30_000, requests: 4 });
  });

  it("keeps the year's requests without a line apart", () => {
    expect(b.unbudgeted).toEqual({ plannedCents: 0, approvedCents: 4_000, pendingCents: 0, requests: 1 });
  });
});

describe("budgetProblem", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const ok = { subteamId: "av", schoolYear: 2026 };

  it("accepts a line of the subteam picked, this school year", () => {
    expect(budgetProblem("av", ok, "boards", now)).toBeNull();
  });

  it("asks for a subteam and a line", () => {
    expect(budgetProblem(null, ok, "boards", now)).toMatch(/subteam/);
    expect(budgetProblem("av", ok, "", now)).toMatch(/budget line/);
  });

  it("refuses a line that is gone, another subteam's, or last year's", () => {
    expect(budgetProblem("av", null, "boards", now)).toMatch(/gone/);
    expect(budgetProblem("pr", ok, "boards", now)).toMatch(/another subteam/);
    expect(budgetProblem("av", { ...ok, schoolYear: 2025 }, "boards", now)).toMatch(/another school year/);
  });

  it("reads the school year in Berkeley time", () => {
    // 2027-07-01 02:00 UTC is still June 30 in Berkeley: 2026-27.
    expect(budgetProblem("av", ok, "boards", new Date("2027-07-01T02:00:00Z"))).toBeNull();
  });
});

describe("budgetLineInputSchema", () => {
  it("parses an amount into cents and drops blank optionals", () => {
    expect(budgetLineInputSchema.parse({ name: " Boards ", amount: "1,200.50", projectId: "", note: " " })).toEqual({
      name: "Boards",
      amount: 120_050,
    });
  });

  it("wants a name and a nonzero amount", () => {
    const r = budgetLineInputSchema.safeParse({ name: "", amount: "0" });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0])).toEqual(["name", "amount"]);
  });
});

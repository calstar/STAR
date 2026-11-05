import { z } from "zod";

import { schoolYearOf } from "@/lib/finance/ledger";
import { parseMoney } from "@/lib/finance/money";
import { itemApproved, type PrStatus } from "@/lib/purchase-requests";

// Budgets: each subteam's planned spending for a school year, line by line, and
// what PVPs have approved against each line on purchase requests. Pure, so the
// Finance tab, the subteam's Budget page, the request dialog and the tests share
// one set of sums.

export type BudgetLineIn = {
  id: string;
  subteamId: string;
  projectId: string | null;
  name: string;
  plannedCents: number;
  note: string | null;
};

export type BudgetRequestIn = {
  status: PrStatus;
  budgetLineId: string | null;
  subteamId: string | null;
  createdAt: Date | string;
  items: { predictedCents: number; approved: boolean | null }[];
};

export type BudgetSubteamIn = { id: string; name: string; color: string | null };

/** What a request spends: the lines a PVP approved, and the whole of one still waiting. */
export function requestSpend(r: Pick<BudgetRequestIn, "status" | "items">): { approvedCents: number; pendingCents: number } {
  let approvedCents = 0;
  let pendingCents = 0;
  for (const i of r.items) {
    if (r.status === "pending") pendingCents += i.predictedCents;
    else if (itemApproved(r.status, i.approved) === true) approvedCents += i.predictedCents;
  }
  return { approvedCents, pendingCents };
}

export type Tally = { plannedCents: number; approvedCents: number; pendingCents: number; requests: number };

const empty = (): Tally => ({ plannedCents: 0, approvedCents: 0, pendingCents: 0, requests: 0 });

/** Planned less approved; negative when a line or subteam is over. Pending isn't spent yet. */
export const remainingCents = (t: Pick<Tally, "plannedCents" | "approvedCents">) => t.plannedCents - t.approvedCents;

export type BudgetLineRow = BudgetLineIn & { projectLabel: string | null; tally: Tally };

export type BudgetSubteamRow = BudgetSubteamIn & { tally: Tally; lines: BudgetLineRow[] };

export type Budget = {
  year: number;
  /** Every subteam, the ones with a budget first (largest plan first), then the rest by name. */
  subteams: BudgetSubteamRow[];
  total: Tally;
  /** Requests in the year that name no budget line (made before budgets existed). */
  unbudgeted: Tally;
};

/**
 * The year's budget: `lines` are that year's lines; `requests` may be any, as
 * only those on one of the lines (or, with no line, made in the year) count.
 */
export function budgetFor(
  year: number,
  lines: BudgetLineIn[],
  requests: BudgetRequestIn[],
  subteams: BudgetSubteamIn[],
  projectLabel: (id: string) => string | null,
): Budget {
  const byLine = new Map<string, Tally>(lines.map((l) => [l.id, { ...empty(), plannedCents: l.plannedCents }]));
  const unbudgeted = empty();
  for (const r of requests) {
    const t = r.budgetLineId ? byLine.get(r.budgetLineId) : !r.budgetLineId && schoolYearOf(r.createdAt) === year ? unbudgeted : undefined;
    if (!t) continue;
    const s = requestSpend(r);
    t.approvedCents += s.approvedCents;
    t.pendingCents += s.pendingCents;
    t.requests += 1;
  }

  const rows: BudgetSubteamRow[] = subteams.map((s) => {
    const own = lines
      .filter((l) => l.subteamId === s.id)
      .map((l) => ({ ...l, projectLabel: l.projectId ? projectLabel(l.projectId) : null, tally: byLine.get(l.id)! }));
    return { ...s, lines: own, tally: sum(own.map((l) => l.tally)) };
  });
  rows.sort((a, b) => Number(b.lines.length > 0) - Number(a.lines.length > 0) || b.tally.plannedCents - a.tally.plannedCents || a.name.localeCompare(b.name));

  return { year, subteams: rows, total: sum(rows.map((r) => r.tally)), unbudgeted };
}

function sum(ts: Tally[]): Tally {
  const out = empty();
  for (const t of ts) {
    out.plannedCents += t.plannedCents;
    out.approvedCents += t.approvedCents;
    out.pendingCents += t.pendingCents;
    out.requests += t.requests;
  }
  return out;
}

/**
 * Why a new purchase request can't spend this line, or null if it can. The line
 * must belong to the subteam picked and to the school year the request is made in.
 */
export function budgetProblem(
  subteamId: string | null | undefined,
  line: Pick<BudgetLineIn, "subteamId"> & { schoolYear: number } | null,
  budgetLineId: string | null | undefined,
  now: Date,
): string | null {
  if (!subteamId) return "Pick the subteam this is for.";
  if (!budgetLineId) return "Pick the budget line it comes out of.";
  if (!line) return "That budget line is gone; pick another.";
  if (line.subteamId !== subteamId) return "That budget line belongs to another subteam.";
  if (line.schoolYear !== schoolYearOf(now)) return "That budget line is from another school year.";
  return null;
}

// ---- what a member types --------------------------------------------------------

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(max).optional());

/** A line's editable fields. Its subteam and year are fixed when it is made. */
export const budgetLineInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name the line").max(150),
    amount: z.string().transform((s, ctx) => {
      const c = parseMoney(s);
      if (c == null || c === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the amount, like 1200" });
      return c ?? 0;
    }),
    projectId: optionalText(64),
    note: optionalText(500),
  })
  .strict();

export type BudgetLineInput = z.input<typeof budgetLineInputSchema>;

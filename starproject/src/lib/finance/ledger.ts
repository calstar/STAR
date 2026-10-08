import type { ReimbursementStatus } from "@prisma/client";

import { descendants, flatten, type ProjectTree } from "@/lib/project-tree";

// The Finance tab's arithmetic: school years, what counts as spending, and the
// breakdowns. Pure, so it is tested without a database.

const TZ = "America/Los_Angeles";

/** A school year runs July 1 to June 30, the UC fiscal year CalLink's accounts
 * roll over on, so summer build season belongs to the year it ends. */
export const SCHOOL_YEAR_START_MONTH = 7;

/** The school year a moment falls in, named by the year it starts: Oct 2026 → 2026,
 * Mar 2027 → 2026. Read in Berkeley time, so 11 pm on June 30 is still June. */
export function schoolYearOf(when: Date | string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric" }).formatToParts(new Date(when));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return month >= SCHOOL_YEAR_START_MONTH ? year : year - 1;
}

/** Months into the school year, Berkeley time: July → 0, June → 11. */
export function schoolMonthOf(when: Date | string): number {
  const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric" }).format(new Date(when)));
  return (m - SCHOOL_YEAR_START_MONTH + 12) % 12;
}

/** The school year's months in order, for chart axes: ["Jul", …, "Jun"]. */
export const SCHOOL_MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2000, (SCHOOL_YEAR_START_MONTH - 1 + i) % 12, 15)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
);

/** 2026 → "2026–27". */
export const schoolYearLabel = (y: number) => `${y}–${String((y + 1) % 100).padStart(2, "0")}`;

export type SpendInput = {
  amountCents: number;
  approvedAmountCents: number | null;
  status: ReimbursementStatus;
  callinkStatus: string | null;
  callinkDeletedOn: Date | null;
  submittedOn: Date | null;
  createdAt: Date;
  projectId: string | null;
  subteamId: string | null;
};

/**
 * How a reimbursement counts toward the year's spending: "paid" once CalLink has
 * approved it, "pending" while it is on its way (waiting for an admin, queued, or
 * unapproved on CalLink), null when it never will be (rejected, cancelled, denied,
 * deleted, or a filing that failed and was not retried).
 */
export function spendStage(r: Pick<SpendInput, "status" | "callinkStatus" | "callinkDeletedOn">): "paid" | "pending" | null {
  if (r.status === "rejected" || r.status === "cancelled" || r.status === "failed") return null;
  if (r.status !== "submitted") return "pending";
  if (r.callinkDeletedOn) return null;
  if (r.callinkStatus === "Denied" || r.callinkStatus === "Canceled") return null;
  if (r.callinkStatus === "Approved" || r.callinkStatus === "Completed" || r.callinkStatus === "Paid") return "paid";
  return "pending";
}

/** What CalLink approved when it has said, else what was asked for. */
export const spendCents = (r: Pick<SpendInput, "amountCents" | "approvedAmountCents">) => r.approvedAmountCents ?? r.amountCents;

/** The date a reimbursement is booked on: when it went to CalLink, else when it was filed here. */
export const spendDate = (r: Pick<SpendInput, "submittedOn" | "createdAt">) => r.submittedOn ?? r.createdAt;

export type Bucket = { paidCents: number; pendingCents: number; count: number };

const empty = (): Bucket => ({ paidCents: 0, pendingCents: 0, count: 0 });
const add = (b: Bucket, stage: "paid" | "pending", cents: number) => {
  if (stage === "paid") b.paidCents += cents;
  else b.pendingCents += cents;
  b.count += 1;
};

export type SpendingRow = { id: string | null; name: string; depth: number; bucket: Bucket };

export type Spending = {
  total: Bucket;
  /** Subteams with spending, biggest first; untagged last. */
  bySubteam: SpendingRow[];
  /** Projects in tree order, each with everything under it rolled in; untagged last. */
  byProject: SpendingRow[];
  /** Twelve buckets, July first. */
  byMonth: Bucket[];
  /** Every subteam and top-level project in a fixed order, so a chart colours each one
   * the same whichever year is shown. */
  subteamOrder: string[];
  projectOrder: string[];
};

export const UNTAGGED = "Not tagged";

/** One school year's spending, by subteam and by project. */
export function spendingFor(
  year: number,
  rows: SpendInput[],
  subteams: { id: string; name: string }[],
  tree: ProjectTree,
): Spending {
  const total = empty();
  const own = new Map<string | null, Bucket>();
  const team = new Map<string | null, Bucket>();
  const byMonth = Array.from({ length: 12 }, empty);
  for (const r of rows) {
    const stage = spendStage(r);
    if (!stage || schoolYearOf(spendDate(r)) !== year) continue;
    const cents = spendCents(r);
    add(total, stage, cents);
    add(byMonth[schoolMonthOf(spendDate(r))], stage, cents);
    const p = r.projectId && tree.byId.has(r.projectId) ? r.projectId : null;
    const s = r.subteamId && subteams.some((t) => t.id === r.subteamId) ? r.subteamId : null;
    if (!own.has(p)) own.set(p, empty());
    if (!team.has(s)) team.set(s, empty());
    add(own.get(p)!, stage, cents);
    add(team.get(s)!, stage, cents);
  }

  const size = (b: Bucket) => b.paidCents + b.pendingCents;
  const bySubteam: SpendingRow[] = subteams
    .filter((t) => team.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, depth: 0, bucket: team.get(t.id)! }))
    .sort((a, b) => size(b.bucket) - size(a.bucket) || a.name.localeCompare(b.name));
  if (team.has(null)) bySubteam.push({ id: null, name: UNTAGGED, depth: 0, bucket: team.get(null)! });

  const byProject: SpendingRow[] = [];
  for (const { node, depth } of flatten(tree, { includeArchived: true })) {
    const rolled = empty();
    for (const id of [node.id, ...descendants(tree, node.id, { includeArchived: true }).map((d) => d.id)]) {
      const b = own.get(id);
      if (!b) continue;
      rolled.paidCents += b.paidCents;
      rolled.pendingCents += b.pendingCents;
      rolled.count += b.count;
    }
    if (rolled.count) byProject.push({ id: node.id, name: node.name, depth, bucket: rolled });
  }
  if (own.has(null)) byProject.push({ id: null, name: UNTAGGED, depth: 0, bucket: own.get(null)! });

  return {
    total,
    bySubteam,
    byProject,
    byMonth,
    subteamOrder: subteams.map((t) => t.id),
    projectOrder: (tree.childrenOf.get(null) ?? []).map((n) => n.id),
  };
}

/** The school years there is anything to show for, newest first, always including this one. */
export function yearsWithData(now: Date, dates: (Date | string)[], incomeYears: number[]): number[] {
  const ys = new Set<number>([schoolYearOf(now), ...incomeYears, ...dates.map(schoolYearOf)]);
  return [...ys].sort((a, b) => b - a);
}

/** CalLink's SUMMARY account carries the STAR total; every other CalLink account is part of it. */
export const isSummaryAccount = (name: string) => /^SUMMARY-/i.test(name.trim());

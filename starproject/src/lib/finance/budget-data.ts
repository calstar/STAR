import { prisma } from "@/lib/db";
import { budgetFor, remainingCents, type Budget } from "@/lib/finance/budget";
import { schoolYearOf } from "@/lib/finance/ledger";
import { pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getSubteams } from "@/lib/subteams";

// Loading budgets for the Finance tab, a subteam's Budget page and the purchase
// request dialog. Server-only.

const REQUEST_SELECT = {
  status: true,
  budgetLineId: true,
  subteamId: true,
  createdAt: true,
  items: { select: { predictedCents: true, approved: true } },
} as const;

/** The year's budget, every subteam's or just one's. */
export async function getBudget(year: number, subteamId?: string): Promise<Budget> {
  const [lines, subteams, tree] = await Promise.all([
    prisma.budgetLine.findMany({
      where: { schoolYear: year, ...(subteamId ? { subteamId } : {}) },
      orderBy: [{ createdAt: "asc" }],
    }),
    getSubteams(),
    getProjectTree(),
  ]);
  // Requests on these lines, plus (for the whole team) the year's requests with no line.
  const requests = await prisma.purchaseRequest.findMany({
    where: subteamId
      ? { budgetLineId: { in: lines.map((l) => l.id) } }
      : { OR: [{ budgetLineId: { in: lines.map((l) => l.id) } }, { budgetLineId: null }] },
    select: REQUEST_SELECT,
  });
  const label = (id: string) => (tree.byId.has(id) ? pathOf(tree, id) : null);
  return budgetFor(
    year,
    lines,
    requests,
    subteams.filter((s) => !subteamId || s.id === subteamId),
    label,
  );
}

/** School years that have budget lines. */
export async function budgetYears(): Promise<number[]> {
  const rows = await prisma.budgetLine.findMany({ distinct: ["schoolYear"], select: { schoolYear: true } });
  return rows.map((r) => r.schoolYear);
}

export type BudgetOption = {
  id: string;
  name: string;
  projectLabel: string | null;
  plannedCents: number;
  remainingCents: number;
  pendingCents: number;
};

/** What the purchase request dialog offers: each subteam and its lines for this school year. */
export async function getBudgetOptions(now = new Date()): Promise<{
  year: number;
  subteams: { id: string; name: string; lines: BudgetOption[] }[];
}> {
  const year = schoolYearOf(now);
  const b = await getBudget(year);
  return {
    year,
    subteams: b.subteams
      .map((s) => ({
        id: s.id,
        name: s.name,
        lines: s.lines.map((l) => ({
          id: l.id,
          name: l.name,
          projectLabel: l.projectLabel,
          plannedCents: l.plannedCents,
          remainingCents: remainingCents(l.tally),
          pendingCents: l.tally.pendingCents,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

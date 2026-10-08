import { prisma } from "@/lib/db";
import { isSummaryAccount, schoolYearOf, spendDate, spendingFor, yearsWithData, type Spending } from "@/lib/finance/ledger";
import { displayNameOf } from "@/lib/names";
import { getProjectTree } from "@/lib/projects";
import { getSubteams } from "@/lib/subteams";

// Server-only reads for the Finance tab (admins only; the page checks).

export type AccountRow = {
  id: string;
  name: string;
  source: "callink" | "manual";
  balanceCents: number;
  availableCents: number | null;
  balanceAsOf: string;
  note: string | null;
  updatedBy: string | null;
};

export type IncomeRow = {
  id: string;
  source: string;
  amountCents: number;
  expectedOn: string | null; // YYYY-MM-DD
  received: boolean;
  note: string | null;
};

export type FinanceOverview = {
  year: number;
  years: number[];
  /** CalLink's SUMMARY account: the STAR total. Null until the worker has reported it. */
  summary: AccountRow | null;
  /** CalLink's other accounts, which the summary already includes. */
  callink: AccountRow[];
  manual: AccountRow[];
  spending: Spending;
  income: IncomeRow[];
};

export async function getFinanceOverview(requestedYear: number | null, now = new Date()): Promise<FinanceOverview> {
  const [accounts, reimbursements, subteams, tree, incomeYears] = await Promise.all([
    prisma.financeAccount.findMany({
      where: { archived: false },
      include: { updatedBy: { select: { name: true, email: true, displayName: true } } },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.reimbursement.findMany({
      select: {
        amountCents: true,
        approvedAmountCents: true,
        status: true,
        callinkStatus: true,
        callinkDeletedOn: true,
        submittedOn: true,
        createdAt: true,
        projectId: true,
        subteamId: true,
      },
    }),
    getSubteams(),
    getProjectTree(),
    prisma.plannedIncome.findMany({ distinct: ["schoolYear"], select: { schoolYear: true } }),
  ]);

  const years = yearsWithData(now, reimbursements.map(spendDate), incomeYears.map((i) => i.schoolYear));
  const year = requestedYear != null && years.includes(requestedYear) ? requestedYear : schoolYearOf(now);

  const income = await prisma.plannedIncome.findMany({
    where: { schoolYear: year },
    orderBy: [{ expectedOn: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });

  const rows: AccountRow[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    source: a.callinkAccountId != null ? "callink" : "manual",
    balanceCents: a.balanceCents,
    availableCents: a.availableCents,
    balanceAsOf: a.balanceAsOf.toISOString(),
    note: a.note,
    updatedBy: a.updatedBy ? displayNameOf(a.updatedBy) : null,
  }));
  const fromCallink = rows.filter((a) => a.source === "callink");

  return {
    year,
    years,
    summary: fromCallink.find((a) => isSummaryAccount(a.name)) ?? null,
    callink: fromCallink.filter((a) => !isSummaryAccount(a.name)).sort((a, b) => b.balanceCents - a.balanceCents),
    manual: rows.filter((a) => a.source === "manual"),
    spending: spendingFor(year, reimbursements, subteams, tree),
    income: income.map((i) => ({
      id: i.id,
      source: i.source,
      amountCents: i.amountCents,
      expectedOn: i.expectedOn ? i.expectedOn.toISOString().slice(0, 10) : null,
      received: i.received,
      note: i.note,
    })),
  };
}

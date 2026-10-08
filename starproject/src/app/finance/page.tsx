import { redirect } from "next/navigation";

import { PAGE_CONTAINER } from "@/components/EntityRow";
import { AccountsPanel } from "@/components/finance/AccountsPanel";
import { IncomePanel } from "@/components/finance/IncomePanel";
import { MonthlySpending } from "@/components/finance/MonthlySpending";
import { SpendingBreakdown } from "@/components/finance/SpendingBreakdown";
import { YearPicker } from "@/components/finance/YearPicker";
import { schoolYearLabel } from "@/lib/finance/ledger";
import { formatCents } from "@/lib/finance/money";
import { getFinanceOverview } from "@/lib/finance/overview";
import { getViewer } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

const card = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm";

/** Admins only: the team's money. Balances, the year's spending, and planned income. */
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ year?: string; r?: string }> }) {
  const params = await searchParams;
  // Reimbursement links from before the tab was split (/finance?r=12).
  if (params.r) redirect(`/reimbursements?r=${encodeURIComponent(params.r)}`);
  const viewer = await getViewer();
  if (!viewer.isAdmin) redirect("/reimbursements");

  const requested = Number(params.year);
  const o = await getFinanceOverview(Number.isInteger(requested) ? requested : null);
  const spentCents = o.spending.total.paidCents + o.spending.total.pendingCents;
  const plannedCents = o.income.reduce((s, i) => s + i.amountCents, 0);
  const manualCents = o.manual.reduce((s, a) => s + a.balanceCents, 0);

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Finance</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Admins only. What STAR holds, spends and expects.</p>
        </div>
        <YearPicker year={o.year} years={o.years} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="STAR account (CalLink)"
          value={o.summary ? formatCents(o.summary.balanceCents) : "—"}
          sub={o.summary ? undefined : "Waiting for the CalLink worker"}
        />
        <Stat
          label="All accounts"
          value={formatCents((o.summary?.balanceCents ?? 0) + manualCents)}
          sub={`CalLink + ${o.manual.length} other${o.manual.length === 1 ? "" : "s"}`}
        />
        <Stat
          label={`Spent ${schoolYearLabel(o.year)}`}
          value={formatCents(spentCents)}
          sub={o.spending.total.pendingCents ? `${formatCents(o.spending.total.pendingCents)} of it pending` : undefined}
        />
        <Stat label={`Planned income ${schoolYearLabel(o.year)}`} value={formatCents(plannedCents)} sub={`${o.income.length} source${o.income.length === 1 ? "" : "s"}`} />
      </div>

      <section className={`${card} mt-4`}>
        <AccountsPanel summary={o.summary} callink={o.callink} manual={o.manual} />
      </section>

      <section className={`${card} mt-4`}>
        <h2 className="text-sm font-semibold">Spending {schoolYearLabel(o.year)}</h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          From reimbursements booked July 1 to June 30, at CalLink&apos;s approved amount where it has one. Rejected, cancelled,
          denied and deleted requests are left out. Tag a reimbursement with its project and subteam in its card on
          Reimbursements.
        </p>
        <div className="mt-4">
          <MonthlySpending months={o.spending.byMonth} />
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <SpendingBreakdown title="By project" rows={o.spending.byProject} order={o.spending.projectOrder} />
          <SpendingBreakdown title="By subteam" rows={o.spending.bySubteam} order={o.spending.subteamOrder} />
        </div>
      </section>

      <section className={`${card} mt-4`}>
        <IncomePanel key={o.year} year={o.year} rows={o.income} />
      </section>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={card}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{sub}</p>}
    </div>
  );
}

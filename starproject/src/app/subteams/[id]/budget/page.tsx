import Link from "next/link";
import { notFound } from "next/navigation";

import { PAGE_CONTAINER } from "@/components/EntityRow";
import { BudgetPanel } from "@/components/finance/BudgetPanel";
import { YearPicker } from "@/components/finance/YearPicker";
import { prisma } from "@/lib/db";
import { budgetYears, getBudget } from "@/lib/finance/budget-data";
import { schoolYearLabel, schoolYearOf } from "@/lib/finance/ledger";
import { getProjectOptions } from "@/lib/projects";

export const dynamic = "force-dynamic";

const card = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm";

/** A subteam's budget for a school year: its lines, kept by its members, and
 * what PVPs have approved against each. Open to every member. */
export default async function SubteamBudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { id } = await params;
  const { year: rawYear } = await searchParams;
  const subteam = await prisma.subteam.findUnique({ where: { id }, select: { id: true, name: true, color: true } });
  if (!subteam) notFound();

  // This year, next year (budgets are planned ahead), and any year with lines.
  const current = schoolYearOf(new Date());
  const years = [...new Set([current + 1, current, ...(await budgetYears())])].sort((a, b) => b - a);
  const requested = Number(rawYear);
  const year = years.includes(requested) ? requested : current;
  const [budget, projects] = await Promise.all([getBudget(year, subteam.id), getProjectOptions()]);

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="inline-block h-4 w-4 shrink-0 rounded-full" style={{ background: subteam.color ?? "#a3a3a3" }} />
            <h1 className="min-w-0 break-words text-2xl font-semibold">{subteam.name} budget</h1>
          </div>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            What {subteam.name} expects to spend in {schoolYearLabel(year)}, one line per thing. Every purchase request names one
            of these lines; what a PVP approves on it counts against the line.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <YearPicker year={year} years={years} basePath={`/subteams/${subteam.id}/budget`} />
          <Link href={`/subteams/${subteam.id}`} className="inline-flex min-h-11 items-center text-sm text-neutral-500 hover:underline dark:text-neutral-400 sm:min-h-0">
            ← {subteam.name}
          </Link>
        </div>
      </div>
      <section className={card}>
        <BudgetPanel budget={budget} projects={projects} />
      </section>
    </main>
  );
}

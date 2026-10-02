import { PAGE_CONTAINER } from "@/components/EntityRow";
import { FinanceWorkspace, NewReimbursementButton } from "@/components/finance/FinanceWorkspace";
import { prisma } from "@/lib/db";
import { formatWhen } from "@/lib/finance/dates";
import { listFinanceRows, getViewer } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const viewer = await getViewer();
  const rows = await listFinanceRows(viewer);
  const worker = viewer.isAdmin ? await prisma.workerStatus.findUnique({ where: { id: "callink" } }) : null;
  const queued = rows.filter((r) => r.status.key === "approved").length;

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Finance</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Reimbursements filed on CalLink for STAR, past and pending.
          </p>
        </div>
        <NewReimbursementButton />
      </div>
      {viewer.isAdmin && <WorkerBanner worker={worker} queued={queued} />}
      <FinanceWorkspace rows={rows} admin={viewer.isAdmin} />
    </main>
  );
}

const STALE_MS = 30 * 60_000;

// Admins only: whether callink-worker is alive and signed in to CalLink. Its
// session needs a Duo approval once a day.
function WorkerBanner({
  worker,
  queued,
}: {
  worker: { session: string; lastSeenAt: Date; lastScrapeAt: Date | null } | null;
  queued: number;
}) {
  const seen = worker ? formatWhen(worker.lastSeenAt) : null;
  let problem: string | null = null;
  if (!worker) problem = "The CalLink worker hasn't reported in yet.";
  else if (worker.session === "expired") problem = "The CalLink worker's login has expired. Run its login and approve the Duo push.";
  else if (Date.now() - worker.lastSeenAt.getTime() > STALE_MS) problem = `The CalLink worker was last seen ${seen}.`;
  if (!problem && !queued) return null;
  return (
    <p
      className={`mb-4 rounded-lg border p-3 text-sm ${
        problem
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          : "border-neutral-200 bg-white text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
      }`}
    >
      {problem ?? `CalLink worker signed in (last seen ${seen}).`}
      {queued > 0 && ` ${queued} approved request${queued > 1 ? "s" : ""} waiting to be filed.`}
    </p>
  );
}

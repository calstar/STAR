import { PAGE_CONTAINER } from "@/components/EntityRow";
import { FinanceWorkspace, NewReimbursementButton } from "@/components/finance/FinanceWorkspace";
import { listFinanceRows, getViewer } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const viewer = await getViewer();
  const rows = await listFinanceRows(viewer);

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
      <FinanceWorkspace rows={rows} admin={viewer.isAdmin} />
    </main>
  );
}

import { PAGE_CONTAINER } from "@/components/EntityRow";
import { PurchaseRequestsWorkspace } from "@/components/purchase-requests/PurchaseRequestsWorkspace";
import { listPurchaseRequests } from "@/lib/purchase-request-data";
import { isPvp } from "@/lib/pvp";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// Every member sees every purchase request; only a PVP gets Approve / Reject
// (the actions check again on the server). `?pr=12` opens PR-12.
export default async function PurchaseRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ pr?: string }>;
}) {
  const user = await getCurrentDbUser();
  const [requests, pvp, { pr }] = await Promise.all([listPurchaseRequests(), isPvp(user.email), searchParams]);
  const open = Number(pr);

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Purchase Requests</h1>
      </div>
      <PurchaseRequestsWorkspace
        requests={requests}
        viewerId={user.id}
        pvp={pvp}
        openNumber={Number.isInteger(open) && open > 0 ? open : null}
      />
    </main>
  );
}

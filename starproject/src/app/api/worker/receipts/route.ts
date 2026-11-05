import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { MAX_FETCH_BATCH } from "@/lib/finance/receipt-fetch";
import { requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/**
 * Imported receipts someone has asked for (MCP get_reimbursement_receipts) that
 * we don't hold yet, oldest request first, for the worker to download from
 * CalLink: `{ receipts: [{ id, href }] }`. One that failed since it was asked
 * for is left alone until it is asked for again. Nothing else is ever offered.
 */
export async function GET(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const asked = Number(new URL(req.url).searchParams.get("limit") ?? 25);
  const take = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_FETCH_BATCH) : 25;
  const rows = await prisma.$queryRaw<{ id: string; callinkHref: string }[]>`
    SELECT f."id", f."callinkHref"
    FROM "ReceiptFile" f
    WHERE f."callinkHref" IS NOT NULL
      AND f."fetchRequestedAt" IS NOT NULL
      AND (f."fetchFailedAt" IS NULL OR f."fetchFailedAt" < f."fetchRequestedAt")
      AND NOT EXISTS (SELECT 1 FROM "ReceiptBlob" b WHERE b."receiptId" = f."id")
    ORDER BY f."fetchRequestedAt" ASC
    LIMIT ${take}`;
  return NextResponse.json({ receipts: rows.map((r) => ({ id: r.id, href: r.callinkHref })) });
}

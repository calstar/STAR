import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

// A receipt for the job being filed. Only while its request is being filed, so
// the worker token can't be used to read receipts in general.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const receipt = await prisma.receiptFile.findUnique({
    where: { id: (await params).id },
    select: { mimeType: true, blob: { select: { data: true } }, item: { select: { reimbursement: { select: { status: true } } } } },
  });
  if (!receipt?.blob) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (receipt.item.reimbursement.status !== "submitting") {
    return NextResponse.json({ error: "not part of a job in progress" }, { status: 409 });
  }
  return new NextResponse(Buffer.from(receipt.blob.data), {
    headers: { "content-type": receipt.mimeType, "cache-control": "no-store" },
  });
}

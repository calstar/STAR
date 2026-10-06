import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { canSeePii } from "@/lib/finance/access";
import { getViewer } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

// A receipt we hold. Receipts often show a shipping address, so they follow the
// same rule as the payee's PII: the payee, the submitter and admins only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await prisma.receiptFile.findUnique({
    where: { id },
    select: {
      fileName: true,
      mimeType: true,
      blob: { select: { data: true } },
      item: { select: { reimbursement: { select: { createdById: true, payeeEmail: true, submitterEmail: true } } } },
    },
  });
  if (!receipt?.blob) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canSeePii(await getViewer(), receipt.item.reimbursement)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return new NextResponse(Buffer.from(receipt.blob.data), {
    headers: {
      "content-type": receipt.mimeType,
      "content-disposition": `inline; filename="${receipt.fileName.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

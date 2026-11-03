import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { MAX_FETCHED_BYTES, sniffMime } from "@/lib/finance/receipt-fetch";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

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

/** An imported receipt's bytes, downloaded from CalLink by the worker. Its type is read from the bytes. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const id = (await params).id;
  const receipt = await prisma.receiptFile.findUnique({ where: { id }, select: { callinkHref: true } });
  // Only CalLink's receipts: the worker token must not overwrite one a member uploaded.
  if (!receipt?.callinkHref) return NextResponse.json({ error: "not an imported receipt" }, { status: 404 });
  const data = new Uint8Array(await req.arrayBuffer());
  if (data.length === 0) return NextResponse.json({ error: "empty" }, { status: 400 });
  if (data.length > MAX_FETCHED_BYTES) return NextResponse.json({ error: "too large" }, { status: 413 });
  const mimeType = sniffMime(data);
  await prisma.$transaction([
    prisma.receiptBlob.upsert({ where: { receiptId: id }, create: { receiptId: id, data }, update: { data } }),
    prisma.receiptFile.update({ where: { id }, data: { size: data.length, mimeType, fetchFailedAt: null, fetchError: null } }),
  ]);
  return NextResponse.json({ ok: true, size: data.length, mimeType });
}

/** The worker couldn't download it (CalLink answered 404, say); it isn't offered again until asked for again. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ error?: unknown }>(req);
  const error = typeof body?.error === "string" ? body.error.slice(0, 500) : "download failed";
  const done = await prisma.receiptFile.updateMany({
    where: { id: (await params).id, callinkHref: { not: null } },
    data: { fetchFailedAt: new Date(), fetchError: error },
  });
  if (done.count === 0) return NextResponse.json({ error: "not an imported receipt" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

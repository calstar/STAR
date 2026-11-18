import { NextResponse } from "next/server";

import { MAX_RECEIPT_BYTES } from "@/lib/finance/receipts";
import { storeUpload } from "@/lib/finance/receipt-upload";

// An agent's receipt upload (src/lib/finance/receipt-upload.ts): the link
// create_receipt_upload returns. The raw file is the body.
//
//   PUT /api/mcp/uploads/<id>?key=<key>[&name=receipt.pdf]     curl -T receipt.pdf "<uploadUrl>"
//   200 { uploadId, fileName, mimeType, size }
//
// Under /api/mcp so it skips the browser login on the EC2 Caddy (like
// /api/mcp/verify); the one-time key is the only thing that authorizes it, and
// the file can be used only by the user who minted the link. POST is accepted
// the same way for clients that can't PUT.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });

/** Read at most `max` bytes of the body; null when it is longer. */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function upload(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (Number(req.headers.get("content-length") ?? 0) > MAX_RECEIPT_BYTES) return fail(413, "A receipt must be under 4 MB.");
  const bytes = await readCapped(req, MAX_RECEIPT_BYTES);
  if (!bytes) return fail(413, "A receipt must be under 4 MB.");
  const result = await storeUpload(id, key, url.searchParams.get("name"), bytes);
  if (!result.ok) return fail(result.status, result.error);
  return NextResponse.json({ uploadId: id, fileName: result.fileName, mimeType: result.mimeType, size: result.size }, { headers: NO_STORE });
}

export const PUT = upload;
export const POST = upload;

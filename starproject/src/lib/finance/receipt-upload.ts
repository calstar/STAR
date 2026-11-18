import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db";
import { checkReceipt, safeFileName } from "@/lib/finance/receipts";
import { MAX_ITEMS } from "@/lib/finance/schema";
import { issuer } from "@/lib/oauth";

// Receipts an agent uploads straight to us (the ReceiptUpload model). MCP tool
// arguments are JSON, so without this an agent has to inline a PDF as base64 in
// the call. Instead create_receipt_upload hands out one-time links; the agent
// PUTs the file's bytes to one (`curl -T receipt.pdf "<url>"`) and names its id
// in a receipt. The route is /api/mcp/uploads/<id>, under /api/mcp because that
// prefix already skips the browser login on the EC2 Caddy; the key in the link is
// what authorizes the upload, and only the user who minted it can use the file.

/** How long an upload link stays open. */
export const UPLOAD_TTL_MS = 15 * 60 * 1000;
/** How many links one call may mint: one per item of a filing. */
export const MAX_UPLOADS_PER_CALL = MAX_ITEMS;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Whether `key` is the one whose hash was stored, compared in constant time. */
export function keyMatches(key: string, keyHash: string): boolean {
  const a = Buffer.from(hashKey(key), "hex");
  const b = Buffer.from(keyHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const EXT_BY_MAGIC: { ext: string; magic: number[] }[] = [
  { ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
];

/**
 * The name to keep an uploaded receipt under: the one asked for when it carries a
 * receipt extension, else that name (or "receipt") with the extension its bytes
 * show, so `curl -T scan "<url>"` of a PDF still files as scan.pdf.
 */
export function uploadFileName(requested: string | null | undefined, head: Uint8Array): string {
  const name = safeFileName((requested ?? "").trim() || "receipt");
  if (/\.(pdf|png|jpe?g)$/i.test(name)) return name;
  const kind = EXT_BY_MAGIC.find((k) => k.magic.every((b, i) => head[i] === b));
  return kind ? `${name}.${kind.ext}` : name;
}

export type MintedUpload = { uploadId: string; uploadUrl: string; expiresAt: string };

/** Mint `count` upload links for `userId`, sweeping expired ones first. */
export async function mintUploads(userId: string, count: number): Promise<MintedUpload[]> {
  const now = Date.now();
  await prisma.receiptUpload.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  const expiresAt = new Date(now + UPLOAD_TTL_MS);
  const out: MintedUpload[] = [];
  for (let i = 0; i < count; i++) {
    const key = randomBytes(32).toString("base64url");
    const row = await prisma.receiptUpload.create({ data: { userId, keyHash: hashKey(key), expiresAt }, select: { id: true } });
    out.push({ uploadId: row.id, uploadUrl: `${issuer()}/api/mcp/uploads/${row.id}?key=${key}`, expiresAt: expiresAt.toISOString() });
  }
  return out;
}

export type StoreResult = { ok: true; fileName: string; mimeType: string; size: number } | { ok: false; status: number; error: string };

/** The route's work: check the key and the bytes, and keep them. One upload per link. */
export async function storeUpload(id: string, key: string, name: string | null, bytes: Uint8Array<ArrayBuffer>): Promise<StoreResult> {
  const row = await prisma.receiptUpload.findUnique({ where: { id }, select: { keyHash: true, expiresAt: true, uploadedAt: true } });
  // One answer for "no such link" and "wrong key", so ids can't be probed.
  if (!row || !key || !keyMatches(key, row.keyHash)) return { ok: false, status: 404, error: "No such upload link." };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, status: 410, error: "This upload link has expired; mint a new one with create_receipt_upload." };
  if (row.uploadedAt) return { ok: false, status: 409, error: "A file was already uploaded to this link; mint a new one for another file." };

  const fileName = uploadFileName(name, bytes.subarray(0, 8));
  const check = checkReceipt(fileName, bytes.length, bytes.subarray(0, 8));
  if (!check.ok) return { ok: false, status: 400, error: check.error };

  const done = await prisma.receiptUpload.updateMany({
    where: { id, uploadedAt: null },
    data: { fileName, mimeType: check.mime, data: bytes, uploadedAt: new Date() },
  });
  if (done.count === 0) return { ok: false, status: 409, error: "A file was already uploaded to this link; mint a new one for another file." };
  return { ok: true, fileName, mimeType: check.mime, size: bytes.length };
}

/**
 * The caller's uploaded files by id, as the File the form would have attached.
 * Refuses (with every problem) an id that isn't theirs, isn't uploaded yet, or
 * has expired.
 */
export async function loadUploads(userId: string, ids: string[]): Promise<Map<string, File>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.receiptUpload.findMany({
    where: { id: { in: unique }, userId },
    select: { id: true, fileName: true, mimeType: true, data: true, uploadedAt: true, expiresAt: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems: string[] = [];
  const files = new Map<string, File>();
  const now = Date.now();
  for (const id of unique) {
    const r = byId.get(id);
    if (!r) problems.push(`${id}: no such upload of yours`);
    else if (r.expiresAt.getTime() < now) problems.push(`${id}: expired; mint a new link and upload again`);
    else if (!r.uploadedAt || !r.data) problems.push(`${id}: nothing uploaded to it yet (PUT the file to its uploadUrl first)`);
    else {
      const bytes = new Uint8Array(r.data.length);
      bytes.set(r.data);
      files.set(id, new File([bytes], r.fileName ?? "receipt", { type: r.mimeType ?? "application/octet-stream" }));
    }
  }
  if (problems.length) throw new Error(`Some uploads can't be used: ${problems.join("; ")}.`);
  return files;
}

/** Drop uploads a filing or draft has taken its own copy of. */
export async function consumeUploads(userId: string, ids: string[]): Promise<void> {
  if (ids.length) await prisma.receiptUpload.deleteMany({ where: { id: { in: ids }, userId } });
}

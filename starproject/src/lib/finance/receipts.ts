// Receipts are checked by their bytes, not the name or the browser's type. CalLink
// takes up to 4 MB per file.

export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
export const RECEIPT_ACCEPT = ".pdf,.png,.jpg,.jpeg";

const KINDS = [
  { mime: "application/pdf", ext: ["pdf"], magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/png", ext: ["png"], magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: ["jpg", "jpeg"], magic: [0xff, 0xd8, 0xff] },
];

export type ReceiptCheck = { ok: true; mime: string } | { ok: false; error: string };

/** Check a receipt's name, size and leading bytes. */
export function checkReceipt(name: string, size: number, head: Uint8Array): ReceiptCheck {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "heic" || ext === "heif") {
    return { ok: false, error: `${name}: iPhone HEIC photos aren't accepted. Export it as a JPEG or PDF.` };
  }
  if (size === 0) return { ok: false, error: `${name} is empty.` };
  if (size > MAX_RECEIPT_BYTES) {
    return { ok: false, error: `${name} is ${(size / 1024 / 1024).toFixed(1)} MB; CalLink takes files under 4 MB.` };
  }
  const kind = KINDS.find((k) => k.ext.includes(ext));
  if (!kind) return { ok: false, error: `${name}: upload a PDF, PNG or JPEG.` };
  if (!kind.magic.every((b, i) => head[i] === b)) {
    return { ok: false, error: `${name} doesn't look like a real ${ext.toUpperCase()} file.` };
  }
  return { ok: true, mime: kind.mime };
}

/** A name that is safe in a Content-Disposition header and on CalLink. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "receipt";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "receipt").slice(0, 120);
}

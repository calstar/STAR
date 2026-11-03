// Imported receipts: only when someone asks for one (the MCP get_reimbursement_receipts
// tool), callink-worker downloads it from CalLink and hands STARProject the bytes,
// which are kept, so it opens here without a CalLink login from then on. Nothing is
// downloaded in bulk. Pure, so the routes and the tests share the rules.

/** CalLink has accepted bigger files than our own 4 MB limit over the years. */
export const MAX_FETCHED_BYTES = 20 * 1024 * 1024;

/** How long the MCP tool waits for the worker to bring requested receipts in. */
export const FETCH_WAIT_MS = 30_000;

/** How many the worker may ask for at once. */
export const MAX_FETCH_BATCH = 50;

const SAFE = [
  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] }, // RIFF....WEBP
];

/**
 * The type to store a downloaded receipt as, read from its bytes alone. Only
 * PDFs and images get their own type; anything else (a Word file, a HEIC photo,
 * an HTML page) is application/octet-stream, which is only ever served as a
 * download, never rendered on our origin.
 */
export function sniffMime(bytes: Uint8Array): string {
  for (const k of SAFE) {
    if (!k.magic.every((b, i) => bytes[i] === b)) continue;
    if (k.at8 && !k.at8.every((b, i) => bytes[8 + i] === b)) continue;
    return k.mime;
  }
  return "application/octet-stream";
}

/** Whether a stored type may be shown inline (in a tab, or as an MCP image). */
export const isInlineMime = (mime: string) => SAFE.some((k) => k.mime === mime);

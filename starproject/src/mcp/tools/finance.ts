import { z } from "zod";

import {
  approveReimbursement,
  cancelReimbursement,
  rejectReimbursement,
  requestCallinkLogin,
  resolveNeedsCheck,
  retryReimbursement,
} from "@/lib/actions/finance";
import { requireAdmin } from "@/lib/admins";
import { canSeePii } from "@/lib/finance/access";
import { FETCH_WAIT_MS, isInlineMime } from "@/lib/finance/receipt-fetch";
import { requirePvp } from "@/lib/pvp";
import { prisma } from "@/lib/db";
import { createDraft, deleteDraft, fileDraft, getDraft, listDrafts, updateDraft } from "@/lib/finance/draft-data";
import { draftPatchShape } from "@/lib/finance/drafts";
import { fileReimbursement } from "@/lib/finance/file";
import { schoolYearOf } from "@/lib/finance/ledger";
import { loginView } from "@/lib/finance/login";
import { getFinanceDetail, getProfileDefaults, getViewer, listFinanceRows, type FinanceRow } from "@/lib/finance/queries";
import { MAX_RECEIPT_BYTES, RECEIPT_ACCEPT } from "@/lib/finance/receipts";
import { MAX_ITEMS, reimbursementInputSchema } from "@/lib/finance/schema";
import { getCurrentDbUser } from "@/lib/user";

import { DESTRUCTIVE, READ, WRITE, guardedDefine, rawContent, type ToolModule } from "./_shared";

// Finance: the /reimbursements tab (reimbursements filed on CalLink for STAR) and the
// actions in src/lib/actions/finance.ts. Reads reuse the page's queries, so the
// PII redaction is the page's (src/lib/finance/access.ts): the payee's address,
// phone, UID and receipts are shown only to the payee, the filer and admins.
// Filing goes through `fileReimbursement`, the same code as the web form's
// POST /api/finance/requests. The pure helpers at the top are tested without a
// database (finance.test.ts).
//
// Over MCP the whole module is for PVPs only, for now: every tool refuses
// anyone else before it runs, whatever the page would let them do.

export type FinanceFilter = {
  /** A displayStatus key: pending_approval, approved, needs_check, "callink:Approved", ... */
  status?: string;
  /** Only rows the viewer filed, is paid by, or submitted on CalLink. */
  mine?: boolean;
  /** Only rows an admin has to act on (the "Needs review" chip). */
  review?: boolean;
  /** Substring of "R-<n> subject payee submitter vendors callink#", case-insensitive. */
  search?: string;
  /** Substring of the payee's or the submitter's name, case-insensitive. */
  person?: string;
  /** Substring of any item's vendor, case-insensitive. */
  vendor?: string;
  /** Inclusive bounds on the amount, in dollars. */
  minAmount?: number;
  maxAmount?: number;
  /** Inclusive bounds on the date (submitted to CalLink, else filed), YYYY-MM-DD in Berkeley time. */
  from?: string;
  to?: string;
  /** The school year it falls in, by the year it starts: 2026 is 2026-27. */
  schoolYear?: number;
  source?: "callink" | "starproject";
  projectId?: string;
  subteamId?: string;
};

/** "2026-10-01T05:00:00Z" -> "2026-09-30": the Berkeley calendar day. */
const berkeleyDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

/** The page's client-side filters (src/components/finance/FinanceWorkspace.tsx), plus MCP's own. */
export function filterFinanceRows(rows: FinanceRow[], f: FinanceFilter): FinanceRow[] {
  const q = (f.search ?? "").trim().toLowerCase();
  const person = (f.person ?? "").trim().toLowerCase();
  const vendor = (f.vendor ?? "").trim().toLowerCase();
  const min = f.minAmount == null ? null : Math.round(f.minAmount * 100);
  const max = f.maxAmount == null ? null : Math.round(f.maxAmount * 100);
  return rows.filter((r) => {
    if (f.status && r.status.key !== f.status) return false;
    if (f.mine && !r.mine) return false;
    if (f.review && !r.needsAdmin) return false;
    if (q) {
      const hay = `R-${r.number} ${r.subject} ${r.payeeName} ${r.submitterName ?? ""} ${r.vendors} ${r.callinkRequestNumber ?? ""}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    if (person && !`${r.payeeName}\n${r.submitterName ?? ""}`.toLowerCase().includes(person)) return false;
    if (vendor && !r.vendors.toLowerCase().includes(vendor)) return false;
    if (min != null && r.amountCents < min) return false;
    if (max != null && r.amountCents > max) return false;
    if (f.from || f.to || f.schoolYear != null) {
      const day = berkeleyDay(r.date);
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
      if (f.schoolYear != null && schoolYearOf(r.date) !== f.schoolYear) return false;
    }
    if (f.source && r.source !== f.source) return false;
    if (f.projectId && r.projectId !== f.projectId) return false;
    if (f.subteamId && r.subteamId !== f.subteamId) return false;
    return true;
  });
}

export type FinanceSort = "newest" | "oldest" | "largest" | "smallest";

/** Rows in the order asked for. */
export function sortFinanceRows(rows: FinanceRow[], sort: FinanceSort): FinanceRow[] {
  const by: Record<FinanceSort, (a: FinanceRow, b: FinanceRow) => number> = {
    newest: (a, b) => b.date.localeCompare(a.date),
    oldest: (a, b) => a.date.localeCompare(b.date),
    largest: (a, b) => b.amountCents - a.amountCents,
    smallest: (a, b) => a.amountCents - b.amountCents,
  };
  return [...rows].sort(by[sort]);
}

export type ReceiptInput = { fileName: string; mimeType: string; base64: string };

/** The bare base64 text: no `data:` URL prefix, no MIME line wrapping. */
export function stripBase64(s: string): string {
  return s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
}

/**
 * A base64 receipt as the File the form would have attached. A `data:` URL
 * prefix is tolerated; the bytes are not checked here -- `fileReimbursement`
 * runs `checkReceipt` on the name, size and magic bytes like it does for the
 * browser's upload.
 */
export function receiptToFile(r: ReceiptInput): File {
  const b64 = stripBase64(r.base64);
  const buf = Buffer.from(b64, "base64");
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return new File([bytes], r.fileName, { type: r.mimeType });
}

/** The multipart body ReimbursementForm.tsx builds: `payload` JSON + `receipt-<i>` files. */
export function buildFilingForm(payload: unknown, receipts: ReceiptInput[]): FormData {
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  receipts.forEach((r, i) => form.set(`receipt-${i}`, receiptToFile(r)));
  return form;
}

// Base64 grows bytes by 4/3; anything longer than a 4 MB file encodes to is
// refused before it is decoded (measured without a data: prefix or line
// wrapping). `checkReceipt` still rules on the decoded size.
const MAX_BASE64 = Math.ceil(MAX_RECEIPT_BYTES / 3) * 4;

const receiptSchema = z.object({
  fileName: z.string().trim().min(1).max(200).describe(`Name with extension; one of ${RECEIPT_ACCEPT}`),
  mimeType: z.string().trim().min(1).max(100).describe("application/pdf, image/png or image/jpeg (the bytes are what is checked)"),
  base64: z
    .string()
    .min(1)
    .refine((s) => stripBase64(s).length <= MAX_BASE64, "A receipt must be under 4 MB")
    .describe("The file's bytes, base64 (a data: URL prefix or line wrapping is fine)"),
});

const numberSchema = z.number().int().min(1).describe("The reimbursement's R-number (from list_reimbursements)");

const draftNumberSchema = z.number().int().min(1).describe("The draft's D-number (from list_reimbursement_drafts)");

const draftReceiptsSchema = z
  .array(receiptSchema.extend({ item: z.number().int().min(0).max(MAX_ITEMS - 1).describe("The item it is the receipt for, from 0") }))
  .max(MAX_ITEMS)
  .refine((rs) => new Set(rs.map((r) => r.item)).size === rs.length, "One receipt per item")
  .optional()
  .describe("Receipts by item index; one given for an item replaces the one it had");

const asDraftReceipts = (rs: z.infer<typeof draftReceiptsSchema>) => (rs ?? []).map((r) => ({ item: r.item, file: receiptToFile(r) }));

/** Each row's items (date, vendor, amount, CalLink's type, receipt names), by reimbursement id. */
async function itemsByReimbursement(ids: string[]) {
  const items = await prisma.reimbursementItem.findMany({
    where: { reimbursementId: { in: ids } },
    orderBy: [{ reimbursementId: "asc" }, { position: "asc" }],
    select: {
      reimbursementId: true,
      position: true,
      date: true,
      vendor: true,
      amountCents: true,
      amountText: true,
      type: true,
      comment: true,
      receipts: { select: { fileName: true } },
    },
  });
  const out = new Map<string, object[]>();
  for (const { reimbursementId, receipts, ...it } of items) {
    const list = out.get(reimbursementId) ?? [];
    list.push({ ...it, receipts: receipts.map((r) => r.fileName) });
    out.set(reimbursementId, list);
  }
  return out;
}

async function requireId(number: number): Promise<string> {
  const r = await prisma.reimbursement.findUnique({ where: { number }, select: { id: true } });
  if (!r) throw new Error(`No reimbursement R-${number}`);
  return r.id;
}

async function readDetail(number: number) {
  const detail = await getFinanceDetail(number, await getViewer());
  if (!detail) throw new Error(`No reimbursement R-${number}`);
  return detail;
}

/** At most this much file data in one tool result; the rest is listed, to ask for by item. */
export const MAX_RESULT_FILE_BYTES = 20 * 1024 * 1024;

const RECEIPT_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  size: true,
  callinkHref: true,
  fetchRequestedAt: true,
  fetchFailedAt: true,
  fetchError: true,
  blob: { select: { receiptId: true } },
} as const;

async function loadForReceipts(number: number, item: number | undefined) {
  return prisma.reimbursement.findUnique({
    where: { number },
    select: {
      number: true,
      subject: true,
      source: true,
      amountCents: true,
      approvedAmountCents: true,
      callinkRequestNumber: true,
      createdById: true,
      payeeEmail: true,
      submitterEmail: true,
      items: {
        where: item ? { position: item } : {},
        orderBy: { position: "asc" },
        select: {
          position: true,
          date: true,
          vendor: true,
          amountCents: true,
          amountText: true,
          type: true,
          location: true,
          invoice: true,
          comment: true,
          receipts: { orderBy: { createdAt: "asc" }, select: RECEIPT_SELECT },
        },
      },
    },
  });
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Ask the worker for imported receipts we don't hold, and wait (up to
 * FETCH_WAIT_MS) while it brings them in from CalLink. Only these receipts are
 * ever downloaded: nothing is fetched until someone asks. Returns a note when
 * the worker can't be expected to answer.
 */
async function fetchFromCallink(ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const askedAt = new Date();
  await prisma.receiptFile.updateMany({ where: { id: { in: ids }, blob: null }, data: { fetchRequestedAt: askedAt } });
  const worker = await prisma.workerStatus.findUnique({ where: { id: "callink" }, select: { session: true, lastSeenAt: true } });
  if (!worker || Date.now() - worker.lastSeenAt.getTime() > 10 * 60_000) {
    return "The CalLink worker hasn't reported in for over 10 minutes; the receipts are requested and come in once it is back.";
  }
  if (worker.session !== "ok") {
    return "The CalLink worker's session has expired; an admin presses \"Sign in to CalLink\" on Reimbursements, then the requested receipts come in.";
  }
  for (const end = Date.now() + FETCH_WAIT_MS; Date.now() < end; ) {
    await sleep(1500);
    const waiting = await prisma.receiptFile.count({
      where: { id: { in: ids }, blob: null, OR: [{ fetchFailedAt: null }, { fetchFailedAt: { lt: askedAt } }] },
    });
    if (waiting === 0) return null;
  }
  return `Not every requested receipt arrived within ${FETCH_WAIT_MS / 1000} s; they stay requested, so call again in a minute.`;
}

/**
 * A reimbursement's line items and its receipt files, as MCP content: one text
 * block (the items, and for each receipt whether it is attached and why not),
 * then each file, a PDF as an embedded resource, an image as an image. An
 * imported receipt we don't hold yet is downloaded from CalLink for this call
 * and kept. Receipts follow the page's rule: the payee, the filer and admins only.
 */
async function receiptContent(number: number, item: number | undefined) {
  const first = await loadForReceipts(number, item);
  if (!first) throw new Error(`No reimbursement R-${number}`);
  if (item && first.items.length === 0) throw new Error(`R-${number} has no item ${item}`);
  if (!canSeePii(await getViewer(), first)) throw new Error(`Receipts on R-${number} are for its payee, its filer and admins only.`);

  const missing = first.items.flatMap((it) => it.receipts).filter((f) => !f.blob && f.callinkHref);
  const note = await fetchFromCallink(missing.map((f) => f.id));
  const r = missing.length ? (await loadForReceipts(number, item))! : first;

  let budget = MAX_RESULT_FILE_BYTES;
  const files: Exclude<Parameters<typeof rawContent>[0], undefined> = [];
  const items = [];
  for (const it of r.items) {
    const receipts = [];
    for (const f of it.receipts) {
      const blob = f.blob ? await prisma.receiptBlob.findUnique({ where: { receiptId: f.id }, select: { data: true } }) : null;
      let attached: string;
      if (!blob) {
        const failed = f.fetchFailedAt && f.fetchRequestedAt && f.fetchFailedAt >= f.fetchRequestedAt;
        attached = !f.callinkHref
          ? "no: no file is stored for it"
          : failed
            ? `no: the download from CalLink failed (${f.fetchError ?? "unknown error"}); asking again retries it`
            : "no: requested from CalLink, not in yet";
      } else if (blob.data.length > budget) {
        attached = `no: over this result's ${MAX_RESULT_FILE_BYTES / 1024 / 1024} MB of files; ask for item ${it.position} alone`;
      } else {
        budget -= blob.data.length;
        attached = "yes";
        const data = Buffer.from(blob.data).toString("base64");
        if (f.mimeType.startsWith("image/") && isInlineMime(f.mimeType)) files.push({ type: "image", data, mimeType: f.mimeType });
        else files.push({ type: "resource", resource: { uri: `starproject://receipts/${f.id}/${encodeURIComponent(f.fileName)}`, mimeType: f.mimeType, blob: data } });
      }
      receipts.push({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: blob?.data.length ?? f.size, attached, callinkUrl: f.callinkHref });
    }
    items.push({ ...it, receipts });
  }
  const { createdById: _c, payeeEmail: _p, submitterEmail: _s, items: _i, ...head } = r;
  const summary = { ...head, items, filesAttached: files.length, ...(note ? { note } : {}) };
  return rawContent([{ type: "text", text: JSON.stringify(summary, null, 2) }, ...files]);
}

/** Run one of the finance actions and throw its `error` as the tool's. */
async function act(number: number, run: (id: string) => Promise<{ ok: true } | { error: string }>) {
  const id = await requireId(number);
  const result = await run(id);
  if ("error" in result) throw new Error(result.error);
  return readDetail(number);
}

export const financeTools: ToolModule = (server) => {
  const define = guardedDefine(server, requirePvp);
  define(
    "list_reimbursements",
    {
      description:
        "PVPs only (MCP). Every reimbursement, STAR's own and those imported from CalLink, with the display " +
        "status a member sees, payee, submitter, vendors, amount in cents, date, source, and whether it is yours " +
        "(mine) or waiting on an admin (needsAdmin). Filters, all optional and combined with AND: status (a " +
        "display-status key: pending_approval, approved, submitting, failed, rejected, cancelled, needs_check, " +
        "submitted, callink:<Status> such as callink:Approved), mine, review (needs an admin), search (number, " +
        "subject, payee, submitter, vendors, CalLink #), person (payee or submitter name), vendor, minAmount / " +
        "maxAmount in dollars, from / to (YYYY-MM-DD, Berkeley days), schoolYear (2026 = 2026-27), source " +
        "(callink = imported, starproject = filed here), projectId, subteamId. sort: newest (default), oldest, " +
        "largest, smallest; limit caps the rows returned. withItems adds each row's line items (date, vendor, " +
        "amount, CalLink's type, receipt file names); get_reimbursement has the receipt links. Returns " +
        "{ total, totalCents, rows } where total and totalCents cover every match, before limit.",
      inputSchema: {
        status: z.string().trim().min(1).optional(),
        mine: z.boolean().default(false),
        review: z.boolean().default(false),
        search: z.string().trim().optional(),
        person: z.string().trim().min(1).optional().describe("Part of the payee's or submitter's name"),
        vendor: z.string().trim().min(1).optional().describe("Part of a vendor's name"),
        minAmount: z.number().nonnegative().optional().describe("Dollars, inclusive"),
        maxAmount: z.number().nonnegative().optional().describe("Dollars, inclusive"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("On or after this day"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("On or before this day"),
        schoolYear: z.number().int().min(2000).max(2100).optional(),
        source: z.enum(["callink", "starproject"]).optional(),
        projectId: z.string().min(1).optional(),
        subteamId: z.string().min(1).optional(),
        sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest"),
        limit: z.number().int().min(1).max(1000).optional(),
        withItems: z.boolean().default(false),
      },
      annotations: READ,
    },
    async ({ sort, limit, withItems, ...filter }) => {
      const matched = sortFinanceRows(filterFinanceRows(await listFinanceRows(await getViewer()), filter), sort);
      const page = limit ? matched.slice(0, limit) : matched;
      const items = withItems ? await itemsByReimbursement(page.map((r) => r.id)) : null;
      return {
        total: matched.length,
        totalCents: matched.reduce((n, r) => n + r.amountCents, 0),
        rows: items ? page.map((r) => ({ ...r, items: items.get(r.id) ?? [] })) : page,
      };
    },
  );

  define(
    "get_reimbursement",
    {
      description:
        "PVPs only (MCP). One reimbursement by its R-number, as its card on Reimbursements shows it: fields, items with receipts, the event " +
        "timeline, and `can` (what you may do to it). The payee's address, phone, UID and the receipt links are " +
        "included only for the payee, the filer and admins; everyone else gets them redacted.",
      inputSchema: { number: numberSchema },
      annotations: READ,
    },
    async ({ number }) => readDetail(number),
  );

  define(
    "get_reimbursement_receipts",
    {
      description:
        "PVPs only (MCP). A reimbursement's line items (date, vendor, amount, CalLink's type, location, invoice, " +
        "comment) and the receipt files themselves: a PDF comes back as an embedded resource, an image as an " +
        "image. item (1-6) narrows it to one item. A CalLink receipt not yet held is downloaded from CalLink " +
        "for this call (it can take up to 30 s) and kept; nothing is downloaded unless asked for. Each receipt " +
        "says whether it is attached and, if not, why. Up to 20 MB of files per call. Receipts are for the " +
        "payee, the filer and admins only.",
      inputSchema: {
        number: numberSchema,
        item: z.number().int().min(1).max(MAX_ITEMS).optional().describe("Only this item (its position, 1-6)"),
      },
      annotations: READ,
    },
    async ({ number, item }) => receiptContent(number, item),
  );

  define(
    "get_payee_defaults",
    {
      description:
        "PVPs only (MCP). What the New reimbursement form pre-fills for you: your saved payee profile, else the payee details on " +
        "your newest CalLink request, else your account email and name. `saved` says whether a profile exists; " +
        "`seededFrom` names the CalLink request the values came from.",
      inputSchema: {},
      annotations: READ,
    },
    async () => getProfileDefaults(await getCurrentDbUser()),
  );

  define(
    "file_reimbursement",
    {
      description:
        "PVPs only (MCP). File a reimbursement, exactly as the New reimbursement form does. It lands as pending_approval; nothing " +
        `goes to CalLink until an admin approves it. 1 to ${MAX_ITEMS} items, each with its receipt in \`receipts\` at the ` +
        "same index (PDF, PNG or JPEG under 4 MB, checked by its bytes). Amounts are text like \"12.34\"; the " +
        "total is their sum. saveProfile (default true) remembers the payee details as your profile. Returns the " +
        "new R-number and the reimbursement. bomItemIds (ids from list_bom) marks the BOM lines this filing pays back.",
      inputSchema: {
        ...reimbursementInputSchema.innerType().shape,
        receipts: z.array(receiptSchema).min(1).max(MAX_ITEMS).describe("One per item, in item order"),
      },
      annotations: WRITE,
    },
    async ({ receipts, ...payload }) => {
      if (receipts.length !== payload.items.length) {
        throw new Error(`Attach one receipt per item: ${payload.items.length} item(s), ${receipts.length} receipt(s).`);
      }
      const user = await getCurrentDbUser();
      const result = await fileReimbursement(user, buildFilingForm(payload, receipts));
      if ("error" in result) {
        const fields = Object.entries(result.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v}`);
        throw new Error([result.error, ...fields].join(" -- "));
      }
      return { number: result.number, reimbursement: await readDetail(result.number) };
    },
  );

  define(
    "list_reimbursement_drafts",
    {
      description:
        "PVPs only (MCP). Your reimbursement drafts (only yours), last changed first: the fields so far, the receipts attached by " +
        "item index, and `problems`, everything still missing before it can be filed (empty when `ready`).",
      inputSchema: {},
      annotations: READ,
    },
    async () => listDrafts((await getCurrentDbUser()).id),
  );

  define(
    "get_reimbursement_draft",
    {
      description: "PVPs only (MCP). One of your drafts by its D-number, with its fields, receipts and what is still missing (`problems`).",
      inputSchema: { number: draftNumberSchema },
      annotations: READ,
    },
    async ({ number }) => getDraft((await getCurrentDbUser()).id, number),
  );

  define(
    "draft_reimbursement",
    {
      description:
        "PVPs only (MCP). Start a reimbursement draft: any of file_reimbursement's fields, as many as are known, plus receipts by " +
        "item index. Nothing is filed and nobody else sees it. Values are checked as the form would check them " +
        "(an email must look like one) but nothing is required yet; `problems` in the result lists what filing " +
        "still needs. get_payee_defaults has the payee details the form would pre-fill. Returns the draft (D-number).",
      inputSchema: { ...draftPatchShape, receipts: draftReceiptsSchema },
      annotations: WRITE,
    },
    async ({ receipts, ...patch }) => createDraft((await getCurrentDbUser()).id, patch, asDraftReceipts(receipts)),
  );

  define(
    "update_reimbursement_draft",
    {
      description:
        "PVPs only (MCP). Change one of your drafts. Fields given replace the draft's (payee merges field by field; items replaces " +
        "the whole list), fields left out stay. receipts sets the receipt for those item indexes; removeReceipts " +
        "drops the ones at those indexes. Returns the draft with what is still missing.",
      inputSchema: {
        number: draftNumberSchema,
        ...draftPatchShape,
        receipts: draftReceiptsSchema,
        removeReceipts: z.array(z.number().int().min(0)).max(50).optional().describe("Item indexes whose receipt to drop"),
      },
      annotations: WRITE,
    },
    async ({ number, receipts, removeReceipts, ...patch }) =>
      updateDraft((await getCurrentDbUser()).id, number, patch, asDraftReceipts(receipts), removeReceipts ?? []),
  );

  define(
    "file_reimbursement_draft",
    {
      description:
        "PVPs only (MCP). File one of your drafts, exactly as file_reimbursement does (it lands as pending_approval; nothing goes " +
        "to CalLink until an admin approves it), then delete the draft. Refused, with the list, while the draft " +
        "has problems. Returns the new R-number and the reimbursement.",
      inputSchema: { number: draftNumberSchema },
      annotations: WRITE,
    },
    async ({ number }) => {
      const filed = await fileDraft(await getCurrentDbUser(), number);
      return { number: filed.number, reimbursement: await readDetail(filed.number) };
    },
  );

  define(
    "delete_reimbursement_draft",
    {
      description: "PVPs only (MCP). Throw away one of your drafts and its receipts.",
      inputSchema: { number: draftNumberSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ number }) => {
      await deleteDraft((await getCurrentDbUser()).id, number);
      return { deleted: `D-${number}` };
    },
  );

  define(
    "approve_reimbursement",
    {
      description:
        "PVPs only (MCP). Admins only. Approve a pending_approval reimbursement: it is queued for the CalLink worker to file. " +
        "Returns the refreshed reimbursement.",
      inputSchema: { number: numberSchema },
      annotations: WRITE,
    },
    async ({ number }) => act(number, (id) => approveReimbursement(id)),
  );

  define(
    "reject_reimbursement",
    {
      description:
        "PVPs only (MCP). Admins only. Reject a pending_approval reimbursement with a reason the member sees (required, under 1000 " +
        "characters). Final: a rejected reimbursement cannot be reopened.",
      inputSchema: {
        number: numberSchema,
        note: z.string().trim().min(1, "Say why it's rejected").max(1000).describe("Why; shown to the member"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ number, note }) => act(number, (id) => rejectReimbursement(id, note)),
  );

  define(
    "retry_reimbursement",
    {
      description: "PVPs only (MCP). Admins only. Put a failed filing back in the queue (failed -> approved) and clear its last error.",
      inputSchema: { number: numberSchema },
      annotations: WRITE,
    },
    async ({ number }) => act(number, (id) => retryReimbursement(id)),
  );

  define(
    "cancel_reimbursement",
    {
      description:
        "PVPs only (MCP). Cancel a reimbursement before it reaches CalLink. The member who filed it may cancel while it is " +
        "pending_approval; an admin may also cancel one that is approved (queued) or failed. Final.",
      inputSchema: { number: numberSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ number }) => act(number, (id) => cancelReimbursement(id)),
  );

  define(
    "resolve_needs_check",
    {
      description:
        "PVPs only (MCP). Admins only. A filing the worker could not confirm (status submitting, needsCheck): record what you found " +
        "on CalLink by searching its [STAR R-n] tag. filed: true marks it submitted (the next scrape links it); " +
        "filed: false queues it again.",
      inputSchema: {
        number: numberSchema,
        filed: z.boolean().describe("true if the request is on CalLink, false if it is not"),
      },
      annotations: WRITE,
    },
    async ({ number, filed }) => act(number, (id) => resolveNeedsCheck(id, filed)),
  );

  define(
    "request_callink_login",
    {
      description:
        "PVPs only (MCP). Admins only. Ask callink-worker to sign in to CalLink (the Reimbursements banner's button). The worker picks it " +
        "up within seconds and Duo pushes to the CalNet account owner's phone. Refused while a sign-in is under way " +
        "or if the worker has never reported in.",
      inputSchema: {},
      annotations: WRITE,
    },
    async () => {
      const result = await requestCallinkLogin();
      if ("error" in result) throw new Error(result.error);
      return { ok: true };
    },
  );

  define(
    "get_worker_status",
    {
      description:
        "PVPs only (MCP). Admins only. The CalLink worker's last report (the Reimbursements banner): session state and expiry, last seen, " +
        "last scrape, and the sign-in request's state, plus `login` as the banner words it. `worker` is null when " +
        "the worker has never reported in.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await requireAdmin();
      const worker = await prisma.workerStatus.findUnique({ where: { id: "callink" } });
      return { worker, login: loginView(worker, Date.now()) };
    },
  );
};

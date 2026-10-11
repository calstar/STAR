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
import { prisma } from "@/lib/db";
import { fileReimbursement } from "@/lib/finance/file";
import { loginView } from "@/lib/finance/login";
import { getFinanceDetail, getProfileDefaults, getViewer, listFinanceRows, type FinanceRow } from "@/lib/finance/queries";
import { MAX_RECEIPT_BYTES, RECEIPT_ACCEPT } from "@/lib/finance/receipts";
import { MAX_ITEMS, reimbursementInputSchema } from "@/lib/finance/schema";
import { getCurrentDbUser } from "@/lib/user";

import { DESTRUCTIVE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// Finance: the /finance tab (reimbursements filed on CalLink for STAR) and the
// actions in src/lib/actions/finance.ts. Reads reuse the page's queries, so the
// PII redaction is the page's (src/lib/finance/access.ts): the payee's address,
// phone, UID and receipts are shown only to the payee, the filer and admins.
// Filing goes through `fileReimbursement`, the same code as the web form's
// POST /api/finance/requests. The pure helpers at the top are tested without a
// database (finance.test.ts).

export type FinanceFilter = {
  /** A displayStatus key: pending_approval, approved, needs_check, "callink:Approved", ... */
  status?: string;
  /** Only rows the viewer filed, is paid by, or submitted on CalLink. */
  mine?: boolean;
  /** Only rows an admin has to act on (the "Needs review" chip). */
  review?: boolean;
  /** Substring of "R-<n> subject payee submitter vendors callink#", case-insensitive. */
  search?: string;
};

/** The client-side filters of src/components/finance/FinanceWorkspace.tsx, verbatim. */
export function filterFinanceRows(rows: FinanceRow[], f: FinanceFilter): FinanceRow[] {
  const q = (f.search ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status && r.status.key !== f.status) return false;
    if (f.mine && !r.mine) return false;
    if (f.review && !r.needsAdmin) return false;
    if (q) {
      const hay = `R-${r.number} ${r.subject} ${r.payeeName} ${r.submitterName ?? ""} ${r.vendors} ${r.callinkRequestNumber ?? ""}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
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

/** Run one of the finance actions and throw its `error` as the tool's. */
async function act(number: number, run: (id: string) => Promise<{ ok: true } | { error: string }>) {
  const id = await requireId(number);
  const result = await run(id);
  if ("error" in result) throw new Error(result.error);
  return readDetail(number);
}

export const financeTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_reimbursements",
    {
      description:
        "The Finance tab's table: every reimbursement (STAR's and those imported from CalLink), newest first, " +
        "with the one display status a member sees, payee, submitter, vendors, amount in cents, and whether it is " +
        "yours (mine) or waiting on an admin (needsAdmin). Filters are the page's: status is a display-status key " +
        "(pending_approval, approved, submitting, failed, rejected, cancelled, needs_check, submitted, callink:<Status>), " +
        "mine, review (needs an admin), and a search over number, subject, payee, submitter, vendors and CalLink #.",
      inputSchema: {
        status: z.string().trim().min(1).optional(),
        mine: z.boolean().default(false),
        review: z.boolean().default(false),
        search: z.string().trim().optional(),
      },
      annotations: READ,
    },
    async ({ status, mine, review, search }) => {
      const rows = await listFinanceRows(await getViewer());
      return filterFinanceRows(rows, { status, mine, review, search });
    },
  );

  defineTool(
    server,
    "get_reimbursement",
    {
      description:
        "One reimbursement by its R-number, as the Finance card shows it: fields, items with receipts, the event " +
        "timeline, and `can` (what you may do to it). The payee's address, phone, UID and the receipt links are " +
        "included only for the payee, the filer and admins; everyone else gets them redacted.",
      inputSchema: { number: numberSchema },
      annotations: READ,
    },
    async ({ number }) => readDetail(number),
  );

  defineTool(
    server,
    "get_payee_defaults",
    {
      description:
        "What the New reimbursement form pre-fills for you: your saved payee profile, else the payee details on " +
        "your newest CalLink request, else your account email and name. `saved` says whether a profile exists; " +
        "`seededFrom` names the CalLink request the values came from.",
      inputSchema: {},
      annotations: READ,
    },
    async () => getProfileDefaults(await getCurrentDbUser()),
  );

  defineTool(
    server,
    "file_reimbursement",
    {
      description:
        "File a reimbursement, exactly as the New reimbursement form does. It lands as pending_approval; nothing " +
        `goes to CalLink until an admin approves it. 1 to ${MAX_ITEMS} items, each with its receipt in \`receipts\` at the ` +
        "same index (PDF, PNG or JPEG under 4 MB, checked by its bytes). Amounts are text like \"12.34\"; the " +
        "total is their sum. saveProfile (default true) remembers the payee details as your profile. Returns the " +
        "new R-number and the reimbursement.",
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

  defineTool(
    server,
    "approve_reimbursement",
    {
      description:
        "Admins only. Approve a pending_approval reimbursement: it is queued for the CalLink worker to file. " +
        "Returns the refreshed reimbursement.",
      inputSchema: { number: numberSchema },
      annotations: WRITE,
    },
    async ({ number }) => act(number, (id) => approveReimbursement(id)),
  );

  defineTool(
    server,
    "reject_reimbursement",
    {
      description:
        "Admins only. Reject a pending_approval reimbursement with a reason the member sees (required, under 1000 " +
        "characters). Final: a rejected reimbursement cannot be reopened.",
      inputSchema: {
        number: numberSchema,
        note: z.string().trim().min(1, "Say why it's rejected").max(1000).describe("Why; shown to the member"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ number, note }) => act(number, (id) => rejectReimbursement(id, note)),
  );

  defineTool(
    server,
    "retry_reimbursement",
    {
      description: "Admins only. Put a failed filing back in the queue (failed -> approved) and clear its last error.",
      inputSchema: { number: numberSchema },
      annotations: WRITE,
    },
    async ({ number }) => act(number, (id) => retryReimbursement(id)),
  );

  defineTool(
    server,
    "cancel_reimbursement",
    {
      description:
        "Cancel a reimbursement before it reaches CalLink. The member who filed it may cancel while it is " +
        "pending_approval; an admin may also cancel one that is approved (queued) or failed. Final.",
      inputSchema: { number: numberSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ number }) => act(number, (id) => cancelReimbursement(id)),
  );

  defineTool(
    server,
    "resolve_needs_check",
    {
      description:
        "Admins only. A filing the worker could not confirm (status submitting, needsCheck): record what you found " +
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

  defineTool(
    server,
    "request_callink_login",
    {
      description:
        "Admins only. Ask callink-worker to sign in to CalLink (the Finance banner's button). The worker picks it " +
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

  defineTool(
    server,
    "get_worker_status",
    {
      description:
        "Admins only. The CalLink worker's last report (the Finance banner): session state and expiry, last seen, " +
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

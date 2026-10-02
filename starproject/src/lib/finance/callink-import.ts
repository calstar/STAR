import { parseMoney } from "@/lib/finance/money";

// Turns one record from callink-worker's scrape (requests/<id>.json) into our
// rows. Fields are picked one by one; the raw CalLink detail and answers are
// never stored, because the payee's UID and phone sit inside free-text answers.

export const CALLINK_BASE = "https://callink.berkeley.edu";

// The scrape's record shape, as far as we read it.
export type ScrapedRecord = {
  scrapedAt?: string;
  list: {
    id: number;
    requestNumber: number | string;
    name: string;
    status: string;
    currentStepName?: string | null;
    submittedByName?: string | null;
    submittedAmount?: number | null;
    submittedOn?: string | null;
    approvedAmount?: number | null;
    deletedOn?: string | null;
  };
  detail: {
    subject?: string | null;
    description?: string | null;
    financeCategory?: { name?: string | null } | null;
    financeStage?: { name?: string | null } | null;
    payee?: {
      firstName?: string | null;
      lastName?: string | null;
      street?: string | null;
      street2?: string | null;
      city?: string | null;
      state?: string | null;
      zipCode?: string | null;
    } | null;
    submitted?: { communityMemberDisplayName?: string | null; email?: string | null } | null;
  };
  answers: { question: string; answer: string | null; files?: { name: string; href: string; documentId: string | null }[] }[];
  items: {
    item: number;
    date?: string | null;
    type?: string | null;
    vendor?: string | null;
    location?: string | null;
    invoice?: string | null;
    total?: string | null;
    notes?: string | null;
    receipt?: { name: string; href: string; documentId: string | null }[];
  }[];
};

export type MappedReceipt = { fileName: string; mimeType: string; callinkDocumentId: string | null; callinkHref: string };

export type MappedItem = {
  position: number;
  date: string;
  vendor: string;
  amountCents: number | null;
  amountText: string | null;
  comment: string | null;
  type: string | null;
  location: string | null;
  invoice: string | null;
  receipts: MappedReceipt[];
};

export type MappedRequest = {
  callinkId: number;
  /** The [STAR R-n] tag in the subject, when we filed it. */
  tagNumber: number | null;
  mirror: {
    callinkRequestNumber: string;
    callinkStatus: string;
    callinkStage: string | null;
    submittedAmountCents: number | null;
    approvedAmountCents: number | null;
    submittedOn: Date | null;
    callinkDeletedOn: Date | null;
    scrapedAt: Date | null;
  };
  request: {
    subject: string;
    description: string | null;
    eventDetails: string | null;
    specialInstructions: string | null;
    expenditureAction: string;
    directDepositSignedUp: boolean | null;
    category: string | null;
    amountCents: number;
    payeeFirstName: string;
    payeeLastName: string;
    payeeEmail: string | null;
    submitterName: string | null;
    submitterEmail: string | null;
  };
  pii: { street: string; street2: string | null; city: string; state: string; zip: string; phone: string | null; uid: string | null } | null;
  items: MappedItem[];
};

// The form's question labels (as in callink-worker/request.mjs).
const Q = {
  ucMember: /^1\.\s*Is payee a UC Berkeley/i,
  email: /^2\.\s*REQUIRED: Payee's Email/i,
  phone: /^3\.\s*REQUIRED: Payee's Phone/i,
  expenditure: /^4\.\s*Expenditure Action/i,
  special: /^5\.\s*SPECIAL INSTRUCTIONS/i,
  directDeposit: /^6\.\s*Direct Deposit/i,
  event: /^Event Details/i,
};

const TAG_RE = /\[STAR R-(\d+)\]\s*$/;

/** " [STAR R-42]", appended to the CalLink subject of everything we file. */
export function subjectTag(number: number): string {
  return ` [STAR R-${number}]`;
}

export function parseTag(subject: string | null | undefined): number | null {
  const m = TAG_RE.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

const date = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function answer(rec: ScrapedRecord, re: RegExp): string | null {
  return clean(rec.answers.find((a) => re.test(a.question.trim()))?.answer);
}

// CalLink's option texts → the names our form uses.
function expenditureOf(text: string | null): string {
  if (!text) return "Direct Deposit";
  if (/^Direct Deposit/i.test(text)) return "Direct Deposit";
  if (/^Mail to Payee/i.test(text)) return "Mail to Payee";
  if (/^Hold for Pickup/i.test(text)) return "Hold for Pickup";
  return "Other";
}

/** The UID typed after "YES, input their Unique ID…"; a 303… student ID is not one. */
export function uidFrom(q1: string | null): string | null {
  if (!q1) return null;
  return (q1.match(/\b\d{7,8}\b/g) ?? []).find((n) => !n.startsWith("303")) ?? null;
}

const mimeOf = (name: string) => {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
};

export function mapScrapedRecord(rec: ScrapedRecord): MappedRequest {
  const { list, detail } = rec;
  const subject = clean(detail.subject) ?? clean(list.name) ?? `CalLink request ${list.requestNumber}`;
  const payee = detail.payee ?? {};
  const submitterName = clean(detail.submitted?.communityMemberDisplayName) ?? clean(list.submittedByName);
  // A few old requests have no payee name; the submitter is the best stand-in.
  const [fallbackFirst = "", ...fallbackRest] = (submitterName ?? "").split(" ");
  const ddAnswer = answer(rec, Q.directDeposit);
  const submittedCents = list.submittedAmount == null ? null : Math.round(list.submittedAmount * 100);

  const street = clean(payee.street);
  const pii =
    street || clean(payee.city) || clean(payee.zipCode)
      ? {
          street: street ?? "",
          street2: clean(payee.street2),
          city: clean(payee.city) ?? "",
          state: clean(payee.state) ?? "",
          zip: clean(payee.zipCode) ?? "",
          phone: answer(rec, Q.phone),
          uid: uidFrom(answer(rec, Q.ucMember)),
        }
      : null;

  return {
    callinkId: list.id,
    tagNumber: parseTag(subject),
    mirror: {
      callinkRequestNumber: String(list.requestNumber),
      callinkStatus: list.status,
      callinkStage: clean(list.currentStepName) ?? clean(detail.financeStage?.name),
      submittedAmountCents: submittedCents,
      approvedAmountCents: list.approvedAmount == null ? null : Math.round(list.approvedAmount * 100),
      submittedOn: date(list.submittedOn),
      callinkDeletedOn: date(list.deletedOn),
      scrapedAt: date(rec.scrapedAt),
    },
    request: {
      subject,
      description: clean(detail.description),
      eventDetails: answer(rec, Q.event),
      specialInstructions: answer(rec, Q.special),
      expenditureAction: expenditureOf(answer(rec, Q.expenditure)),
      directDepositSignedUp: ddAnswer ? /already successfully completed/i.test(ddAnswer) : null,
      category: clean(detail.financeCategory?.name),
      amountCents: submittedCents ?? 0,
      payeeFirstName: clean(payee.firstName) ?? fallbackFirst,
      payeeLastName: clean(payee.lastName) ?? fallbackRest.join(" "),
      payeeEmail: answer(rec, Q.email)?.toLowerCase() ?? null,
      submitterName,
      submitterEmail: clean(detail.submitted?.email)?.toLowerCase() ?? null,
    },
    pii,
    items: rec.items.map((it) => ({
      position: it.item,
      date: clean(it.date) ?? "",
      vendor: clean(it.vendor) ?? "",
      amountCents: parseMoney(it.total),
      amountText: clean(it.total),
      comment: clean(it.notes),
      type: clean(it.type),
      location: clean(it.location),
      invoice: clean(it.invoice),
      receipts: (it.receipt ?? []).map((f) => ({
        fileName: f.name,
        mimeType: mimeOf(f.name),
        callinkDocumentId: f.documentId,
        callinkHref: new URL(f.href, CALLINK_BASE).href,
      })),
    })),
  };
}

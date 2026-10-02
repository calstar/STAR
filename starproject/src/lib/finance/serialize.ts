import { subjectTag } from "@/lib/finance/callink-import";
import { centsToPlain } from "@/lib/finance/money";
import { safeFileName } from "@/lib/finance/receipts";

// One of our reimbursements → the request file callink-worker files on CalLink
// (validated there by request.mjs). Its keys are exactly the ones request.mjs
// allows; everything STAR fixes is filled in by the worker, not sent from here.

export type WorkerRequest = {
  subject: string;
  description?: string;
  payee: { firstName: string; lastName: string; street: string; street2?: string; city: string; state: string; zip: string };
  uid: string;
  email: string;
  phone: string;
  expenditureAction: string;
  directDepositSignedUp: boolean;
  specialInstructions?: string;
  eventDetails?: string;
  items: { date: string; vendor: string; total: string; comment?: string; file: string }[];
};

export type WorkerJobReceipt = { receiptId: string; fileName: string };

type Source = {
  number: number;
  subject: string;
  description: string | null;
  eventDetails: string | null;
  specialInstructions: string | null;
  expenditureAction: string;
  directDepositSignedUp: boolean | null;
  payeeFirstName: string;
  payeeLastName: string;
  payeeEmail: string | null;
  pii: { street: string; street2: string | null; city: string; state: string; zip: string; phone: string | null; uid: string | null } | null;
  items: {
    position: number;
    date: string;
    vendor: string;
    amountCents: number | null;
    comment: string | null;
    receipts: { id: string; fileName: string }[];
  }[];
};

const opt = (s: string | null) => (s && s.trim() ? s : undefined);

/** "2026-10-02" → "10/02/2026", how CalLink's date questions are answered. */
export function toCallinkDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`item date "${iso}" is not YYYY-MM-DD`);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export function toWorkerRequest(r: Source): { request: WorkerRequest; receipts: WorkerJobReceipt[] } {
  const missing = (what: string) => new Error(`R-${r.number} cannot be filed: no ${what}`);
  if (!r.pii) throw missing("payee address");
  if (!r.pii.uid) throw missing("UID");
  if (!r.pii.phone) throw missing("phone");
  if (!r.payeeEmail) throw missing("payee email");
  if (!r.items.length) throw missing("items");

  const receipts: WorkerJobReceipt[] = [];
  const items = [...r.items]
    .sort((a, b) => a.position - b.position)
    .map((it) => {
      // CalLink takes one file per item, so the form takes one too.
      if (it.receipts.length !== 1) throw new Error(`R-${r.number} item ${it.position} needs exactly one receipt`);
      if (it.amountCents == null || it.amountCents <= 0) throw missing(`total on item ${it.position}`);
      const file = `${it.position}-${safeFileName(it.receipts[0].fileName)}`;
      receipts.push({ receiptId: it.receipts[0].id, fileName: file });
      return {
        date: toCallinkDate(it.date),
        vendor: it.vendor,
        total: centsToPlain(it.amountCents),
        comment: opt(it.comment),
        file,
      };
    });

  return {
    request: {
      subject: r.subject + subjectTag(r.number),
      description: opt(r.description),
      payee: {
        firstName: r.payeeFirstName,
        lastName: r.payeeLastName,
        street: r.pii.street,
        street2: opt(r.pii.street2),
        city: r.pii.city,
        state: r.pii.state,
        zip: r.pii.zip,
      },
      uid: r.pii.uid,
      email: r.payeeEmail,
      phone: r.pii.phone,
      expenditureAction: r.expenditureAction,
      directDepositSignedUp: r.directDepositSignedUp ?? true,
      specialInstructions: opt(r.specialInstructions),
      eventDetails: opt(r.eventDetails),
      items,
    },
    receipts,
  };
}

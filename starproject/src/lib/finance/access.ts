// Who may see what. Every member sees every reimbursement; the payee's address,
// phone, UID and the receipt files (which often show a shipping address) are
// shown only to the payee, whoever filed it, and admins.
//
// The viewer is identified by the authenticated account (email from the auth
// gate, user id) only. A payee-profile email is something a member can type, so
// it never grants access.

export type Viewer = { id: string; email: string; isAdmin: boolean };

export type Ownership = {
  createdById: string | null;
  payeeEmail: string | null;
  submitterEmail: string | null;
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The member filed it, is paid by it, or submitted it on CalLink. */
export function isMine(viewer: Pick<Viewer, "id" | "email">, r: Ownership): boolean {
  return (
    (!!r.createdById && r.createdById === viewer.id) ||
    same(viewer.email, r.payeeEmail) ||
    same(viewer.email, r.submitterEmail)
  );
}

export function canSeePii(viewer: Viewer, r: Ownership): boolean {
  return viewer.isAdmin || isMine(viewer, r);
}

// ---- what the browser gets -----------------------------------------------------

export type PiiDto = {
  street: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
  uid: string | null;
};

export type ReceiptDto = {
  id: string;
  fileName: string;
  size: number;
  /** Our copy (/api/finance/receipts/…) or the document on CalLink. */
  url: string;
};

export type ItemDto = {
  position: number;
  date: string;
  vendor: string;
  amountCents: number | null;
  amountText: string | null;
  comment: string | null;
  type: string | null;
  location: string | null;
  invoice: string | null;
  receiptCount: number;
  receipts: ReceiptDto[] | null; // null = not shown to this viewer
};

export type DetailDto<T> = T & { pii: PiiDto | null; items: ItemDto[] };

/** Drop everything only the payee, the filer and admins may see. */
export function redact<T>(detail: DetailDto<T>, allowed: boolean): DetailDto<T> {
  if (allowed) return detail;
  return {
    ...detail,
    pii: null,
    items: detail.items.map((i) => ({ ...i, receipts: null })),
  };
}

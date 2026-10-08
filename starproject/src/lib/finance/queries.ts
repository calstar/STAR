import type { ReimbursementStatus } from "@prisma/client";

import { isAdmin } from "@/lib/admins";
import { canSeePii, isMine, redact, type DetailDto, type ItemDto, type PiiDto, type Viewer } from "@/lib/finance/access";
import { displayStatus, needsAdmin, type Tone } from "@/lib/finance/status";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getCurrentDbUser } from "@/lib/user";

// Server-only reads for the Reimbursements tab. The list never selects the PII table;
// the detail joins it only for viewers allowed to see it, and redacts otherwise.

export async function getViewer(): Promise<Viewer> {
  const user = await getCurrentDbUser();
  return { id: user.id, email: user.email, isAdmin: await isAdmin(user.email) };
}

export type FinanceRow = {
  id: string;
  number: number;
  subject: string;
  payeeName: string;
  submitterName: string | null;
  amountCents: number;
  /** When it went to CalLink, or when it was filed here if it hasn't yet. */
  date: string;
  status: { key: string; label: string; tone: Tone };
  callinkRequestNumber: string | null;
  vendors: string;
  mine: boolean;
  needsAdmin: boolean;
};

export async function listFinanceRows(viewer: Viewer): Promise<FinanceRow[]> {
  const rows = await prisma.reimbursement.findMany({
    select: {
      id: true,
      number: true,
      subject: true,
      payeeFirstName: true,
      payeeLastName: true,
      payeeEmail: true,
      submitterName: true,
      submitterEmail: true,
      createdById: true,
      amountCents: true,
      submittedOn: true,
      createdAt: true,
      status: true,
      callinkStatus: true,
      callinkDeletedOn: true,
      callinkRequestNumber: true,
      needsCheck: true,
      items: { select: { vendor: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.id,
      number: r.number,
      subject: r.subject,
      payeeName: `${r.payeeFirstName} ${r.payeeLastName}`.trim(),
      submitterName: r.submitterName,
      amountCents: r.amountCents,
      date: (r.submittedOn ?? r.createdAt).toISOString(),
      status: displayStatus(r),
      callinkRequestNumber: r.callinkRequestNumber,
      vendors: [...new Set(r.items.map((i) => i.vendor).filter(Boolean))].join(", "),
      mine: isMine(viewer, r),
      needsAdmin: needsAdmin(r),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export type FinanceEvent = {
  id: string;
  kind: string;
  toStatus: string | null;
  note: string | null;
  by: string;
  at: string;
};

export type FinanceDetail = DetailDto<{
  id: string;
  number: number;
  source: "callink" | "starproject";
  status: ReimbursementStatus;
  display: { key: string; label: string; tone: Tone };
  subject: string;
  description: string | null;
  eventDetails: string | null;
  specialInstructions: string | null;
  expenditureAction: string;
  directDepositSignedUp: boolean | null;
  category: string | null;
  amountCents: number;
  payeeName: string;
  payeeEmail: string | null;
  submitterName: string | null;
  createdBy: string | null;
  createdAt: string;
  reviewNote: string | null;
  lastError: string | null;
  needsCheck: boolean;
  callinkId: number | null;
  callinkRequestNumber: string | null;
  callinkStage: string | null;
  submittedOn: string | null;
  approvedAmountCents: number | null;
  projectId: string | null;
  /** "LE4 › Engine", for the read-only view. */
  projectLabel: string | null;
  subteamId: string | null;
  subteamName: string | null;
  events: FinanceEvent[];
  /** What this viewer may do; the actions check again on the server. */
  can: { seePii: boolean; approve: boolean; reject: boolean; retry: boolean; cancel: boolean; resolve: boolean; tag: boolean };
}>;

export async function getFinanceDetail(number: number, viewer: Viewer): Promise<FinanceDetail | null> {
  const r = await prisma.reimbursement.findUnique({
    where: { number },
    include: {
      createdBy: { select: { name: true, email: true, displayName: true } },
      subteam: { select: { name: true } },
      items: {
        orderBy: { position: "asc" },
        include: { receipts: { select: { id: true, fileName: true, size: true, callinkHref: true } } },
      },
      events: {
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { name: true, email: true, displayName: true } } },
      },
    },
  });
  if (!r) return null;

  const allowed = canSeePii(viewer, r);
  const pii: PiiDto | null = allowed
    ? await prisma.reimbursementPii.findUnique({
        where: { reimbursementId: r.id },
        select: { street: true, street2: true, city: true, state: true, zip: true, phone: true, uid: true },
      })
    : null;

  const owner = !!r.createdById && r.createdById === viewer.id;
  const items: ItemDto[] = r.items.map((i) => ({
    position: i.position,
    date: i.date,
    vendor: i.vendor,
    amountCents: i.amountCents,
    amountText: i.amountText,
    comment: i.comment,
    type: i.type,
    location: i.location,
    invoice: i.invoice,
    receiptCount: i.receipts.length,
    receipts: i.receipts.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      size: f.size,
      url: f.callinkHref ?? `/api/finance/receipts/${f.id}`,
    })),
  }));

  const detail: FinanceDetail = {
    id: r.id,
    number: r.number,
    source: r.source,
    status: r.status,
    display: displayStatus(r),
    subject: r.subject,
    description: r.description,
    eventDetails: r.eventDetails,
    specialInstructions: r.specialInstructions,
    expenditureAction: r.expenditureAction,
    directDepositSignedUp: r.directDepositSignedUp,
    category: r.category,
    amountCents: r.amountCents,
    payeeName: `${r.payeeFirstName} ${r.payeeLastName}`.trim(),
    payeeEmail: r.payeeEmail,
    submitterName: r.submitterName,
    createdBy: r.createdBy ? displayNameOf(r.createdBy) : null,
    createdAt: r.createdAt.toISOString(),
    reviewNote: r.reviewNote,
    lastError: viewer.isAdmin ? r.lastError : null,
    needsCheck: r.needsCheck,
    callinkId: r.callinkId,
    callinkRequestNumber: r.callinkRequestNumber,
    callinkStage: r.callinkStage,
    submittedOn: r.submittedOn?.toISOString() ?? null,
    approvedAmountCents: r.approvedAmountCents,
    projectId: r.projectId,
    projectLabel: r.projectId ? pathOf(await getProjectTree(), r.projectId) || null : null,
    subteamId: r.subteamId,
    subteamName: r.subteam?.name ?? null,
    events: r.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      toStatus: e.toStatus,
      note: e.note,
      by: e.actor ? displayNameOf(e.actor) : (e.actorLabel ?? ""),
      at: e.createdAt.toISOString(),
    })),
    can: {
      seePii: allowed,
      approve: viewer.isAdmin && r.status === "pending_approval",
      reject: viewer.isAdmin && r.status === "pending_approval",
      retry: viewer.isAdmin && r.status === "failed",
      cancel:
        (viewer.isAdmin && ["pending_approval", "approved", "failed"].includes(r.status)) ||
        (owner && r.status === "pending_approval"),
      resolve: viewer.isAdmin && r.status === "submitting" && r.needsCheck,
      tag: canTag(viewer, r),
    },
    pii,
    items,
  };
  return redact(detail, allowed);
}

/** Admins tag any reimbursement with its project and subteam; a member, the ones they filed. */
export function canTag(viewer: Viewer, r: { createdById: string | null }): boolean {
  return viewer.isAdmin || (!!r.createdById && r.createdById === viewer.id);
}

export type ProfileDefaults = {
  firstName: string;
  lastName: string;
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  uid: string;
  email: string;
  directDepositSignedUp: boolean;
};

/**
 * What the form starts with: the member's saved payee profile; failing that,
 * the payee details on their newest CalLink request (matched on the signed-in
 * account's email only, so nobody is shown another member's details); failing
 * that, just their account email.
 */
export async function getProfileDefaults(
  user: { id: string; email: string; name: string | null },
): Promise<{ values: ProfileDefaults; seededFrom: string | null; saved: boolean }> {
  const email = user.email.toLowerCase();
  const saved = await prisma.payeeProfile.findUnique({ where: { userId: user.id } });
  if (saved) {
    return {
      values: { ...saved, street2: saved.street2 ?? "", email: saved.email ?? email },
      seededFrom: null,
      saved: true,
    };
  }
  const last = await prisma.reimbursement.findFirst({
    where: { source: "callink", payeeEmail: email, pii: { isNot: null } },
    orderBy: { submittedOn: "desc" },
    select: {
      callinkRequestNumber: true,
      payeeFirstName: true,
      payeeLastName: true,
      directDepositSignedUp: true,
      pii: true,
    },
  });
  if (last?.pii) {
    return {
      values: {
        firstName: last.payeeFirstName,
        lastName: last.payeeLastName,
        street: last.pii.street,
        street2: last.pii.street2 ?? "",
        city: last.pii.city,
        state: last.pii.state,
        zip: last.pii.zip,
        phone: last.pii.phone ?? "",
        uid: last.pii.uid ?? "",
        email,
        directDepositSignedUp: last.directDepositSignedUp ?? true,
      },
      seededFrom: last.callinkRequestNumber,
      saved: false,
    };
  }
  const [first = "", ...rest] = (user.name ?? "").trim().split(/\s+/);
  return {
    values: {
      firstName: first,
      lastName: rest.join(" "),
      street: "",
      street2: "",
      city: "Berkeley",
      state: "CA",
      zip: "",
      phone: "",
      uid: "",
      email,
      directDepositSignedUp: true,
    },
    seededFrom: null,
    saved: false,
  };
}

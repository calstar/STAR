import type { Prisma } from "@prisma/client";

import { type BomLine } from "@/lib/bom";
import { BOM_INCLUDE, toBomLine } from "@/lib/bom-data";
import { prisma } from "@/lib/db";
import { formatCents } from "@/lib/finance/money";
import { displayNameOf } from "@/lib/names";
import { type PrStatus, changedSinceRequested, itemApproved, requestTotal } from "@/lib/purchase-requests";

// Loading purchase requests in the shape the page and the MCP tools show:
// who asked and when, who decided and when, each item as requested next to its
// live BOM line. One loader so the two can never disagree.

const PERSON = { select: { id: true, name: true, email: true, displayName: true } } as const;

const INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  createdBy: PERSON,
  decidedBy: PERSON,
  items: { orderBy: { position: "asc" }, include: { bomItem: { include: BOM_INCLUDE } } },
} satisfies Prisma.PurchaseRequestInclude;

type Row = Prisma.PurchaseRequestGetPayload<{ include: typeof INCLUDE }>;

export type PurchaseRequestView = {
  id: string;
  number: number;
  status: PrStatus;
  project: { id: string; name: string; color: string | null };
  note: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  totalCents: number;
  /** What the PVP approved: every line, or the ones ticked (0 while waiting or rejected). */
  approvedCents: number;
  approvedCount: number;
  items: {
    id: string;
    name: string;
    partNumber: string | null;
    manufacturer: string | null;
    projectName: string;
    kind: "part" | "allowance";
    unitCostCents: number | null;
    quantity: number | null;
    shippingCents: number | null;
    url: string | null;
    predictedCents: number;
    /** The line as it is now; null once deleted. */
    live: BomLine | null;
    changed: boolean;
    /** The PVP's call: null while waiting, else approved or not. */
    approved: boolean | null;
  }[];
};

export function toView(r: Row): PurchaseRequestView {
  const items = r.items.map((i) => {
    const live = i.bomItem ? toBomLine(i.bomItem) : null;
    return {
      id: i.id,
      name: i.name,
      partNumber: i.partNumber,
      manufacturer: i.manufacturer,
      projectName: i.projectName,
      kind: i.kind,
      unitCostCents: i.unitCostCents,
      quantity: i.quantity,
      shippingCents: i.shippingCents,
      url: i.url,
      predictedCents: i.predictedCents,
      live,
      changed: r.status === "pending" && changedSinceRequested(i, live),
      approved: itemApproved(r.status, i.approved),
    };
  });
  const yes = items.filter((i) => i.approved === true);
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    project: r.project,
    note: r.note,
    createdBy: { id: r.createdBy.id, name: displayNameOf(r.createdBy) },
    createdAt: r.createdAt.toISOString(),
    decidedBy: r.decidedBy ? { id: r.decidedBy.id, name: displayNameOf(r.decidedBy) } : null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    totalCents: requestTotal(r.items),
    approvedCents: requestTotal(yes),
    approvedCount: yes.length,
    items,
  };
}

export async function listPurchaseRequests(status?: PrStatus): Promise<PurchaseRequestView[]> {
  const rows = await prisma.purchaseRequest.findMany({
    where: status ? { status } : {},
    include: INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(toView);
}

export async function getPurchaseRequest(by: { id?: string; number?: number }): Promise<PurchaseRequestView | null> {
  const row = await prisma.purchaseRequest.findFirst({
    where: by.id ? { id: by.id } : { number: by.number },
    include: INCLUDE,
  });
  return row ? toView(row) : null;
}

export async function pendingCount(): Promise<number> {
  return prisma.purchaseRequest.count({ where: { status: "pending" } });
}

/** BOM line id -> the PR number it is waiting on, for these lines. */
export async function pendingRequestsFor(lineIds: string[]): Promise<Map<string, number>> {
  if (lineIds.length === 0) return new Map();
  const items = await prisma.purchaseRequestItem.findMany({
    where: { bomItemId: { in: lineIds }, request: { status: "pending" } },
    select: { bomItemId: true, request: { select: { number: true } } },
  });
  return new Map(items.map((i) => [i.bomItemId!, i.request.number]));
}

/** "PR-12 · 3 lines · $123.45", the title an Activity row carries. */
export function prTitle(number: number, lines: number, totalCents: number): string {
  return `PR-${number} · ${lines} line${lines === 1 ? "" : "s"} · ${formatCents(totalCents)}`;
}

// Purchase requests: a member asks for BOM lines to be bought, a PVP approves
// or rejects the whole request. Prisma-free so the page, the server actions, the
// MCP tools and the tests share one set of rules.

import { type BomLine, predictedCents } from "@/lib/bom";

export const PR_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_STATUS_LABEL: Record<PrStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const MAX_REQUEST_LINES = 100;
export const MAX_NOTE = 1000;

export type Actor = { userId: string; pvp: boolean };
type Decidable = { status: PrStatus; createdById: string };

/** Only a PVP decides, and only while the request is waiting. */
export function canDecide(r: Decidable, who: Actor): boolean {
  return who.pvp && r.status === "pending";
}

/** Whoever made it, or a PVP, can withdraw it while it is waiting. */
export function canCancel(r: Decidable, who: Actor): boolean {
  return r.status === "pending" && (who.pvp || r.createdById === who.userId);
}

/**
 * Why these lines can't go on a new request, or null if they can. A line must
 * still be Planned (anything past that is already approved) and not already on
 * a request that is waiting.
 */
export function requestProblem(
  lines: Pick<BomLine, "id" | "name" | "status">[],
  wanted: string[],
  pendingLineIds: Set<string>,
): string | null {
  if (wanted.length === 0) return "Pick at least one line.";
  if (new Set(wanted).size > MAX_REQUEST_LINES) return `At most ${MAX_REQUEST_LINES} lines per request.`;
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const id of new Set(wanted)) {
    const l = byId.get(id);
    if (!l) return "One of those lines is gone; refresh and try again.";
    if (l.status !== "planned") return `“${l.name}” is already past Planned.`;
    if (pendingLineIds.has(id)) return `“${l.name}” is already on a request waiting for a PVP.`;
  }
  return null;
}

/** A request item: the line as it was when requested. */
export type RequestSnapshot = {
  bomItemId: string;
  projectId: string;
  projectName: string;
  kind: BomLine["kind"];
  name: string;
  partNumber: string | null;
  manufacturer: string | null;
  unitCostCents: number | null;
  quantity: number | null;
  shippingCents: number | null;
  url: string | null;
  predictedCents: number;
  position: number;
};

export function snapshotOf(
  line: Pick<BomLine, "id" | "projectId" | "kind" | "name" | "partNumber" | "manufacturer" | "unitCostCents" | "quantity" | "shippingCents" | "url">,
  projectName: string,
  position: number,
): RequestSnapshot {
  return {
    bomItemId: line.id,
    projectId: line.projectId,
    projectName,
    kind: line.kind,
    name: line.name,
    partNumber: line.partNumber,
    manufacturer: line.manufacturer,
    unitCostCents: line.unitCostCents,
    quantity: line.quantity,
    shippingCents: line.shippingCents,
    url: line.url,
    predictedCents: predictedCents(line),
    position,
  };
}

/** Whether the live line now costs something different from what was requested
 * (so the PVP isn't approving a number that has moved under them). A deleted
 * line counts as changed. */
export function changedSinceRequested(
  snap: { predictedCents: number },
  live: Pick<BomLine, "kind" | "unitCostCents" | "quantity" | "shippingCents"> | null,
): boolean {
  return !live || predictedCents(live) !== snap.predictedCents;
}

export const requestTotal = (items: { predictedCents: number }[]) =>
  items.reduce((n, i) => n + i.predictedCents, 0);

/**
 * Which of a request's items a PVP's approval covers: the ones picked, or all
 * of them when none are named. Throws with a message fit to show when the pick
 * is empty or names an item from another request.
 */
export function itemsToApprove(allItemIds: string[], picked?: string[] | null): Set<string> {
  if (!picked) return new Set(allItemIds);
  const all = new Set(allItemIds);
  const chosen = new Set(picked);
  if (chosen.size === 0) throw new Error("Tick at least one line to approve, or reject the request.");
  for (const id of chosen) if (!all.has(id)) throw new Error("That line isn't on this request.");
  return chosen;
}

/** A line's outcome: stored per item since partial approval; older requests
 * approved before that count every line as approved. */
export function itemApproved(status: PrStatus, approved: boolean | null): boolean | null {
  if (approved !== null) return approved;
  return status === "approved" ? true : status === "pending" ? null : false;
}

"use server";

import { revalidatePath } from "next/cache";

import { recordActivity } from "@/lib/activity";
import { BOM_INCLUDE, toBomLine } from "@/lib/bom-data";
import { prisma } from "@/lib/db";
import { budgetProblem } from "@/lib/finance/budget";
import { prTitle } from "@/lib/purchase-request-data";
import {
  MAX_NOTE,
  canCancel,
  canDecide,
  itemsToApprove,
  requestProblem,
  requestTotal,
  snapshotOf,
} from "@/lib/purchase-requests";
import { isPvp } from "@/lib/pvp";
import { getCurrentDbUser } from "@/lib/user";

// Purchase requests: any member asks, only a PVP decides. Approving moves every
// line still Planned to Approved (each logged as a BOM change too); rejecting
// or cancelling leaves the lines Planned, free to be requested again. Every
// request names the subteam and budget line it spends; what is approved counts
// against that line on the Finance tab and the subteam's Budget page.

function revalidate() {
  revalidatePath("/purchase-requests");
  revalidatePath("/finance");
  revalidatePath("/subteams/[id]/budget", "page");
  revalidatePath("/projects/[id]", "page");
  revalidatePath("/activity");
  revalidatePath("/", "layout"); // the sidebar's pending count
}

async function actor() {
  const user = await getCurrentDbUser();
  return { user, who: { userId: user.id, pvp: await isPvp(user.email) } };
}

const cleanNote = (note: string | null | undefined) => {
  const v = (note ?? "").trim();
  if (v.length > MAX_NOTE) throw new Error(`Keep the note under ${MAX_NOTE} characters.`);
  return v || null;
};

/** Ask for these BOM lines to be bought. `projectId` is the BOM page it was made
 * from; `budget` the subteam and the budget line (of this school year) it spends. */
export async function createPurchaseRequest(
  projectId: string,
  bomItemIds: string[],
  note: string | null | undefined,
  budget: { subteamId: string; budgetLineId: string },
): Promise<{ number?: number; error?: string }> {
  const { user } = await actor();
  let text: string | null;
  try {
    text = cleanNote(note);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return { error: "Project not found." };
  const line = budget?.budgetLineId
    ? await prisma.budgetLine.findUnique({ where: { id: budget.budgetLineId }, select: { subteamId: true, schoolYear: true } })
    : null;
  const unbudgeted = budgetProblem(budget?.subteamId, line, budget?.budgetLineId, new Date());
  if (unbudgeted) return { error: unbudgeted };

  const ids = [...new Set(bomItemIds)];
  const rows = await prisma.bomItem.findMany({
    where: { id: { in: ids } },
    include: { ...BOM_INCLUDE, project: { select: { name: true } } },
    orderBy: [{ position: "asc" }],
  });
  const lines = rows.map(toBomLine);
  const pending = await prisma.purchaseRequestItem.findMany({
    where: { bomItemId: { in: ids }, request: { status: "pending" } },
    select: { bomItemId: true },
  });
  const problem = requestProblem(lines, ids, new Set(pending.map((p) => p.bomItemId!)));
  if (problem) return { error: problem };

  const items = rows.map((r, i) => snapshotOf(toBomLine(r), r.project.name, i));
  const created = await prisma.purchaseRequest.create({
    data: {
      projectId,
      note: text,
      subteamId: budget.subteamId,
      budgetLineId: budget.budgetLineId,
      createdById: user.id,
      items: { create: items },
    },
    select: { number: true },
  });
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId,
    taskTitle: prTitle(created.number, items.length, requestTotal(items)),
    kind: "pr_created",
    to: text,
  });
  revalidate();
  return { number: created.number };
}

async function load(id: string) {
  const r = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: { items: { select: { id: true, bomItemId: true, predictedCents: true } } },
  });
  if (!r) throw new Error("That purchase request is gone.");
  return r;
}

/**
 * A PVP says yes to some or all of a request. `itemIds` picks the request items
 * approved (all of them when omitted); their lines still Planned become
 * Approved. Items left out are recorded as not approved and their lines stay
 * Planned, free to be requested again.
 */
export async function approvePurchaseRequest(
  id: string,
  note?: string | null,
  itemIds?: string[] | null,
): Promise<{ error?: string }> {
  const { user, who } = await actor();
  const r = await load(id);
  if (!canDecide(r, who)) return { error: who.pvp ? "This request was already decided." : "Only a PVP can approve a purchase." };
  let text: string | null;
  let chosen: Set<string>;
  try {
    text = cleanNote(note);
    chosen = itemsToApprove(
      r.items.map((i) => i.id),
      itemIds,
    );
  } catch (e) {
    return { error: (e as Error).message };
  }

  const approvedItems = r.items.filter((i) => chosen.has(i.id));
  const lineIds = approvedItems.map((i) => i.bomItemId).filter((x): x is string => !!x);
  const now = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction so two PVPs can't both decide it.
    const { count } = await tx.purchaseRequest.updateMany({
      where: { id, status: "pending" },
      data: { status: "approved", decidedById: user.id, decidedAt: now, decisionNote: text },
    });
    if (count === 0) return null;
    await tx.purchaseRequestItem.updateMany({ where: { requestId: id, id: { in: [...chosen] } }, data: { approved: true } });
    await tx.purchaseRequestItem.updateMany({ where: { requestId: id, id: { notIn: [...chosen] } }, data: { approved: false } });
    const lines = await tx.bomItem.findMany({
      where: { id: { in: lineIds }, status: "planned" },
      select: { id: true, name: true, projectId: true },
    });
    await tx.bomItem.updateMany({
      where: { id: { in: lines.map((l) => l.id) } },
      data: { status: "approved", approvedAt: now },
    });
    return lines;
  });
  if (!moved) return { error: "This request was already decided." };

  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId: r.projectId,
    taskTitle:
      approvedItems.length === r.items.length
        ? prTitle(r.number, r.items.length, requestTotal(r.items))
        : `${prTitle(r.number, approvedItems.length, requestTotal(approvedItems))} of ${r.items.length} requested`,
    kind: "pr_approved",
    to: text,
  });
  for (const l of moved) {
    await recordActivity({
      actorId: user.id,
      taskId: null,
      projectId: l.projectId,
      taskTitle: l.name,
      kind: "bom_updated",
      field: "bom.status",
      from: "Planned",
      to: "Approved",
    });
  }
  revalidate();
  return {};
}

/** A PVP says no, with a reason. The lines stay Planned. */
export async function rejectPurchaseRequest(id: string, reason: string): Promise<{ error?: string }> {
  const { user, who } = await actor();
  const r = await load(id);
  if (!canDecide(r, who)) return { error: who.pvp ? "This request was already decided." : "Only a PVP can reject a purchase." };
  let text: string | null;
  try {
    text = cleanNote(reason);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!text) return { error: "Say why, so the person who asked knows what to change." };
  const { count } = await prisma.purchaseRequest.updateMany({
    where: { id, status: "pending" },
    data: { status: "rejected", decidedById: user.id, decidedAt: new Date(), decisionNote: text },
  });
  if (count === 0) return { error: "This request was already decided." };
  await prisma.purchaseRequestItem.updateMany({ where: { requestId: id }, data: { approved: false } });
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId: r.projectId,
    taskTitle: prTitle(r.number, r.items.length, requestTotal(r.items)),
    kind: "pr_rejected",
    to: text,
  });
  revalidate();
  return {};
}

/** Withdraw a request while it waits: whoever made it, or a PVP. */
export async function cancelPurchaseRequest(id: string): Promise<{ error?: string }> {
  const { user, who } = await actor();
  const r = await load(id);
  if (!canCancel(r, who)) return { error: "Only whoever made it, or a PVP, can cancel a waiting request." };
  const { count } = await prisma.purchaseRequest.updateMany({
    where: { id, status: "pending" },
    data: { status: "cancelled", decidedById: user.id, decidedAt: new Date() },
  });
  if (count === 0) return { error: "This request was already decided." };
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId: r.projectId,
    taskTitle: prTitle(r.number, r.items.length, requestTotal(r.items)),
    kind: "pr_cancelled",
  });
  revalidate();
  return {};
}

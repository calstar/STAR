"use server";

import type { ReimbursementStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { canRequestLogin } from "@/lib/finance/login";
import { canTag, getFinanceDetail, getViewer, type FinanceDetail } from "@/lib/finance/queries";
import { canTransition, type Actor } from "@/lib/finance/status";
import { getCurrentDbUser } from "@/lib/user";

/** The reimbursement modal's data, redacted for the viewer on the server. */
export async function loadReimbursement(number: number): Promise<FinanceDetail | null> {
  if (!Number.isInteger(number) || number < 1) return null;
  return getFinanceDetail(number, await getViewer());
}

type Result = { ok: true } | { error: string };

// Move a reimbursement from its current status to `to`, if the viewer may. The
// update only applies while the status is still the one we read, so two admins
// clicking at once can't both win.
async function move(
  id: string,
  to: ReimbursementStatus,
  event: { kind: string; note?: string },
  data: Record<string, unknown> = {},
  guard?: (r: { status: ReimbursementStatus; needsCheck: boolean }) => string | null,
): Promise<Result> {
  const user = await getCurrentDbUser();
  const r = await prisma.reimbursement.findUnique({
    where: { id },
    select: { status: true, createdById: true, needsCheck: true },
  });
  if (!r) return { error: "That reimbursement no longer exists." };

  const actors: Actor[] = [];
  if (await isAdmin(user.email)) actors.push("admin");
  if (r.createdById === user.id) actors.push("owner");
  const blocked = guard ? guard(r) : canTransition(r.status, to, actors) ? null : "You can't do that to this reimbursement.";
  if (blocked) return { error: blocked };

  const updated = await prisma.reimbursement.updateMany({
    where: { id, status: r.status, needsCheck: r.needsCheck },
    data: { status: to, ...data },
  });
  if (updated.count === 0) return { error: "Someone changed it in the meantime. Reopen it and try again." };
  await prisma.reimbursementEvent.create({
    data: { reimbursementId: id, kind: event.kind, fromStatus: r.status, toStatus: to, note: event.note, actorId: user.id },
  });
  revalidatePath("/reimbursements");
  return { ok: true };
}

export async function approveReimbursement(id: string): Promise<Result> {
  const user = await getCurrentDbUser();
  return move(id, "approved", { kind: "approved" }, { approvedById: user.id, approvedAt: new Date(), reviewNote: null });
}

export async function rejectReimbursement(id: string, note: string): Promise<Result> {
  const reason = note.trim();
  if (!reason) return { error: "Say why it's rejected; the member sees this." };
  if (reason.length > 1000) return { error: "Keep the reason under 1000 characters." };
  return move(id, "rejected", { kind: "rejected", note: reason }, { reviewNote: reason });
}

/** A failed filing goes back in the queue. */
export async function retryReimbursement(id: string): Promise<Result> {
  return move(id, "approved", { kind: "retried" }, { lastError: null });
}

export async function cancelReimbursement(id: string): Promise<Result> {
  return move(id, "cancelled", { kind: "cancelled" });
}

/**
 * The worker may have filed this but couldn't confirm it. An admin looks on
 * CalLink (search for its [STAR R-n] tag) and records what they found: filed (the
 * next scrape links it) or not filed (back in the queue). Never guessed.
 */
export async function resolveNeedsCheck(id: string, filed: boolean): Promise<Result> {
  const user = await getCurrentDbUser();
  const admin = await isAdmin(user.email);
  return move(
    id,
    filed ? "submitted" : "approved",
    { kind: filed ? "submitted" : "retried", note: filed ? "Found on CalLink by an admin" : "Not on CalLink; queued again" },
    { needsCheck: false, leaseUntil: null, lastError: null },
    (r) => (!admin ? "Admins only." : r.status !== "submitting" || !r.needsCheck ? "This doesn't need checking." : null),
  );
}

/** Say what a reimbursement was for (the Finance tab's breakdown). Empty clears it. */
export async function tagReimbursement(id: string, tags: { projectId?: string | null; subteamId?: string | null }): Promise<Result> {
  const viewer = await getViewer();
  const r = await prisma.reimbursement.findUnique({ where: { id }, select: { createdById: true } });
  if (!r) return { error: "That reimbursement no longer exists." };
  if (!canTag(viewer, r)) return { error: "Only an admin or whoever filed it can change this." };
  const data: { projectId?: string | null; subteamId?: string | null } = {};
  if (tags.projectId !== undefined) {
    if (tags.projectId && !(await prisma.project.findUnique({ where: { id: tags.projectId }, select: { id: true } }))) {
      return { error: "That project no longer exists." };
    }
    data.projectId = tags.projectId || null;
  }
  if (tags.subteamId !== undefined) {
    if (tags.subteamId && !(await prisma.subteam.findUnique({ where: { id: tags.subteamId }, select: { id: true } }))) {
      return { error: "That subteam no longer exists." };
    }
    data.subteamId = tags.subteamId || null;
  }
  await prisma.reimbursement.update({ where: { id }, data });
  revalidatePath("/finance");
  return { ok: true };
}

/** Admins: ask callink-worker to sign in to CalLink, which sends the Duo push. */
export async function requestCallinkLogin(): Promise<Result> {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email))) return { error: "Admins only." };
  const now = new Date();
  const status = await prisma.workerStatus.findUnique({ where: { id: "callink" } });
  if (!status) return { error: "The CalLink worker hasn't reported in yet, so nothing would pick this up." };
  if (!canRequestLogin(status, now.getTime())) return { error: "A sign-in is already under way." };
  await prisma.workerStatus.update({
    where: { id: "callink" },
    data: { loginState: "requested", loginRequestedAt: now, loginRequestedBy: user.email, loginUpdatedAt: now, loginNote: null },
  });
  revalidatePath("/reimbursements");
  return { ok: true };
}

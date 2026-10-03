import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { mapScrapedRecord, subjectTag, type MappedRequest, type ScrapedRecord } from "@/lib/finance/callink-import";
import { LOGIN_PICKUP_MS } from "@/lib/finance/login";
import { toWorkerRequest, type WorkerRequest } from "@/lib/finance/serialize";

// What the worker API does. callink-worker is the only caller (token-gated in
// src/app/api/worker). Filing money twice is the failure that matters, so:
// - a claim leases one approved request, atomically;
// - a lease that runs out is never re-filed: it comes back as a "reconcile" job
//   (look for its [STAR R-n] tag on CalLink) until the worker or an admin settles it;
// - "might have filed" (needsCheck) waits for an admin.

export const LEASE_MINUTES = 15;
const WORKER = { actorLabel: "worker" };

export type ClaimedJob =
  | { kind: "none" }
  | { kind: "reconcile"; job: { id: string; number: number; tag: string; subject: string; amountCents: number } }
  | {
      kind: "file";
      job: { id: string; number: number; tag: string; leaseUntil: string };
      request: WorkerRequest;
      receipts: { receiptId: string; fileName: string; url: string }[];
    };

const leaseEnd = () => new Date(Date.now() + LEASE_MINUTES * 60_000);

export async function claimJob(): Promise<ClaimedJob> {
  // 1. A filing whose lease ran out: the worker died mid-way. Check, never re-file.
  const stale = await prisma.reimbursement.findFirst({
    where: { status: "submitting", needsCheck: false, leaseUntil: { lt: new Date() } },
    orderBy: { leaseUntil: "asc" },
    select: { id: true, number: true, subject: true, amountCents: true, leaseUntil: true },
  });
  if (stale) {
    const took = await prisma.reimbursement.updateMany({
      where: { id: stale.id, status: "submitting", leaseUntil: stale.leaseUntil },
      data: { leaseUntil: leaseEnd() },
    });
    if (took.count === 1) {
      return {
        kind: "reconcile",
        job: { id: stale.id, number: stale.number, tag: subjectTag(stale.number).trim(), subject: stale.subject, amountCents: stale.amountCents },
      };
    }
  }

  // 2. The oldest approved request, claimed so no second worker can take it.
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Reimbursement"
       SET status = 'submitting', "leaseUntil" = ${leaseEnd()}, attempts = attempts + 1, "updatedAt" = now()
     WHERE id = (SELECT id FROM "Reimbursement"
                  WHERE status = 'approved'
                  ORDER BY "approvedAt" ASC NULLS LAST, number ASC
                  LIMIT 1
                  FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  if (!claimed.length) return { kind: "none" };
  const id = claimed[0].id;

  const r = await prisma.reimbursement.findUniqueOrThrow({
    where: { id },
    include: {
      pii: true,
      items: { orderBy: { position: "asc" }, include: { receipts: { select: { id: true, fileName: true } } } },
    },
  });
  await prisma.reimbursementEvent.create({
    data: { reimbursementId: id, kind: "claimed", fromStatus: "approved", toStatus: "submitting", ...WORKER },
  });

  try {
    const { request, receipts } = toWorkerRequest(r);
    return {
      kind: "file",
      job: { id, number: r.number, tag: subjectTag(r.number).trim(), leaseUntil: r.leaseUntil!.toISOString() },
      request,
      receipts: receipts.map((f) => ({ ...f, url: `/api/worker/receipts/${f.receiptId}` })),
    };
  } catch (e) {
    // Missing data can't be filed; nothing went to CalLink, so it's a plain failure.
    await finish(id, { ok: false, filed: false, error: e instanceof Error ? e.message : String(e) });
    return { kind: "none" };
  }
}

export type JobResult =
  | { ok: true; callinkId?: number | null; callinkRequestNumber?: string | null }
  | { ok: false; filed: false; error: string }
  | { ok: false; filed: "unknown"; error: string };

export async function finish(id: string, result: JobResult): Promise<{ status: number; body: object }> {
  const r = await prisma.reimbursement.findUnique({ where: { id }, select: { status: true, callinkId: true, needsCheck: true } });
  if (!r) return { status: 404, body: { error: "no such job" } };
  // A repeat of a report already applied is fine (the worker retries on network errors).
  if (result.ok && r.status === "submitted") return { status: 200, body: { status: r.status } };
  if (r.status !== "submitting") return { status: 409, body: { error: `job is ${r.status}, not submitting` } };

  let data: Prisma.ReimbursementUpdateManyMutationInput;
  let event: { kind: string; toStatus: string; note?: string };
  if (result.ok) {
    if (result.callinkId != null) {
      const owner = await prisma.reimbursement.findUnique({ where: { callinkId: result.callinkId }, select: { id: true } });
      if (owner && owner.id !== id) return { status: 409, body: { error: `CalLink ${result.callinkId} already belongs to another request` } };
    }
    data = {
      status: "submitted",
      needsCheck: false,
      leaseUntil: null,
      lastError: null,
      callinkId: result.callinkId ?? r.callinkId,
      callinkRequestNumber: result.callinkRequestNumber ?? undefined,
      callinkStatus: result.callinkId ? "Unapproved" : undefined,
      submittedOn: new Date(),
    };
    event = { kind: "submitted", toStatus: "submitted", note: result.callinkRequestNumber ? `CalLink #${result.callinkRequestNumber}` : undefined };
  } else if (result.filed === false) {
    data = { status: "failed", leaseUntil: null, needsCheck: false, lastError: result.error.slice(0, 2000) };
    event = { kind: "failed", toStatus: "failed", note: result.error.slice(0, 500) };
  } else {
    // Stays "submitting" without a lease, flagged for an admin; claim never hands it out again.
    data = { needsCheck: true, leaseUntil: null, lastError: result.error.slice(0, 2000) };
    event = { kind: "needs_check", toStatus: "submitting", note: result.error.slice(0, 500) };
  }
  const done = await prisma.reimbursement.updateMany({ where: { id, status: "submitting" }, data });
  if (!done.count) return { status: 409, body: { error: "job changed meanwhile" } };
  await prisma.reimbursementEvent.create({ data: { reimbursementId: id, fromStatus: "submitting", ...event, ...WORKER } });
  return { status: 200, body: { status: event.toStatus } };
}

/** A dry run hands its job back untouched. */
export async function release(id: string): Promise<{ status: number; body: object }> {
  const done = await prisma.reimbursement.updateMany({
    where: { id, status: "submitting", needsCheck: false },
    data: { status: "approved", leaseUntil: null, attempts: { decrement: 1 } },
  });
  if (!done.count) return { status: 409, body: { error: "not a job in progress" } };
  await prisma.reimbursementEvent.create({
    data: { reimbursementId: id, kind: "released", fromStatus: "submitting", toStatus: "approved", ...WORKER },
  });
  return { status: 200, body: { status: "approved" } };
}

// ---- the scrape ---------------------------------------------------------------------

export type ScrapeCounts = {
  created: number;
  updated: number;
  linked: number;
  deleted: number;
  /** Set when so many rows would be marked deleted that the scrape is suspect. */
  deleteSkipped?: number;
  failed: { callinkId: number | null; error: string }[];
};

const MAX_DELETIONS_PER_SCRAPE = 10;

const piiData = (m: MappedRequest) => m.pii ?? undefined;

function itemsCreate(m: MappedRequest) {
  return m.items.map((it) => ({
    position: it.position,
    date: it.date,
    vendor: it.vendor,
    amountCents: it.amountCents,
    amountText: it.amountText,
    comment: it.comment,
    type: it.type,
    location: it.location,
    invoice: it.invoice,
    receipts: { create: it.receipts.map((f) => ({ ...f, size: 0 })) },
  }));
}

async function applyRecord(rec: ScrapedRecord, counts: ScrapeCounts) {
  const m = mapScrapedRecord(rec);
  await prisma.$transaction(async (tx) => {
    let row = await tx.reimbursement.findUnique({
      where: { callinkId: m.callinkId },
      select: { id: true, source: true, status: true, callinkStatus: true, needsCheck: true },
    });
    // One of ours, found on CalLink by its tag before the worker reported its id.
    if (!row && m.tagNumber != null) {
      const ours = await tx.reimbursement.findFirst({
        where: { number: m.tagNumber, source: "starproject", callinkId: null },
        select: { id: true, source: true, status: true, callinkStatus: true, needsCheck: true },
      });
      if (ours) {
        row = ours;
        counts.linked++;
      }
    }

    if (!row) {
      await tx.reimbursement.create({
        data: {
          source: "callink",
          status: "submitted",
          callinkId: m.callinkId,
          ...m.mirror,
          ...m.request,
          pii: m.pii ? { create: m.pii } : undefined,
          items: { create: itemsCreate(m) },
          events: { create: { kind: "callink_status", toStatus: m.mirror.callinkStatus, actorLabel: "scrape" } },
        },
      });
      counts.created++;
      return;
    }

    if (row.source === "callink") {
      // Imported rows are CalLink's copy: refresh everything from it.
      await tx.reimbursementItem.deleteMany({ where: { reimbursementId: row.id } });
      await tx.reimbursement.update({
        where: { id: row.id },
        data: {
          ...m.mirror,
          ...m.request,
          pii: piiData(m) ? { upsert: { create: m.pii!, update: m.pii! } } : undefined,
          items: { create: itemsCreate(m) },
        },
      });
    } else {
      // Ours: CalLink's numbers and status only; what the member filed stays as filed.
      // On CalLink means filed, whatever we thought: a "failed" or re-queued request
      // found there must never be filed again.
      const nowFiled = row.status === "submitting" || row.status === "failed" || row.status === "approved";
      await tx.reimbursement.update({
        where: { id: row.id },
        data: {
          callinkId: m.callinkId,
          ...m.mirror,
          ...(nowFiled ? { status: "submitted", needsCheck: false, leaseUntil: null } : {}),
        },
      });
      if (nowFiled) {
        await tx.reimbursementEvent.create({
          data: { reimbursementId: row.id, kind: "submitted", fromStatus: row.status, toStatus: "submitted", note: "Found on CalLink by its tag", actorLabel: "scrape" },
        });
      }
    }
    if (row.callinkStatus !== m.mirror.callinkStatus) {
      await tx.reimbursementEvent.create({
        data: { reimbursementId: row.id, kind: "callink_status", fromStatus: row.callinkStatus, toStatus: m.mirror.callinkStatus, actorLabel: "scrape" },
      });
    }
    counts.updated++;
  });
}

export const MAX_SCRAPE_BATCH = 50;

/**
 * Apply scraped records. `listedIds`, when given, is every request id CalLink
 * lists right now (sent with the last batch of a full scrape); rows CalLink no
 * longer lists were deleted there, since its list omits deleted requests.
 */
export async function importScrape(records: ScrapedRecord[], listedIds?: number[]): Promise<ScrapeCounts> {
  const counts: ScrapeCounts = { created: 0, updated: 0, linked: 0, deleted: 0, failed: [] };
  for (const rec of records) {
    try {
      await applyRecord(rec, counts);
    } catch (e) {
      // Prisma's messages start with a blank line; keep the first line that says something.
      const msg = e instanceof Error ? e.message : String(e);
      const line = msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
      counts.failed.push({ callinkId: rec?.list?.id ?? null, error: line.slice(0, 300) });
    }
  }
  if (listedIds) {
    const gone = await prisma.reimbursement.findMany({
      where: { callinkId: { notIn: listedIds }, NOT: { callinkId: null }, callinkDeletedOn: null },
      select: { id: true },
    });
    // Many vanishing at once is a broken or partial scrape, not a purge on CalLink.
    const onCallink = await prisma.reimbursement.count({ where: { NOT: { callinkId: null } } });
    if (gone.length > Math.max(MAX_DELETIONS_PER_SCRAPE, onCallink * 0.05)) {
      counts.deleteSkipped = gone.length;
      return counts;
    }
    const now = new Date();
    for (const g of gone) {
      await prisma.reimbursement.update({ where: { id: g.id }, data: { callinkDeletedOn: now } });
      await prisma.reimbursementEvent.create({
        data: { reimbursementId: g.id, kind: "callink_status", toStatus: "Deleted", note: "No longer listed on CalLink", actorLabel: "scrape" },
      });
    }
    counts.deleted = gone.length;
  }
  return counts;
}

// ---- heartbeat ----------------------------------------------------------------------

export async function heartbeat(input: {
  session: "ok" | "expired";
  sessionExpiresAt?: string | null;
  lastScrapeAt?: string | null;
  note?: string | null;
}) {
  const data = {
    session: input.session,
    sessionExpiresAt: input.sessionExpiresAt ? new Date(input.sessionExpiresAt) : null,
    lastSeenAt: new Date(),
    lastScrapeAt: input.lastScrapeAt ? new Date(input.lastScrapeAt) : undefined,
    note: input.note ?? null,
  };
  await prisma.workerStatus.upsert({ where: { id: "callink" }, create: { id: "callink", ...data }, update: data });
  const queued = await prisma.reimbursement.count({ where: { status: "approved" } });
  return { queued };
}

// ---- the admin "Sign in to CalLink" button ---------------------------------------------

/** The worker's poll: is there a fresh sign-in request? Takes it, so it runs once. */
export async function takeLoginRequest(): Promise<boolean> {
  const now = new Date();
  const taken = await prisma.workerStatus.updateMany({
    where: { id: "callink", loginState: "requested", loginRequestedAt: { gt: new Date(now.getTime() - LOGIN_PICKUP_MS) } },
    data: { loginState: "running", loginUpdatedAt: now, loginNote: null },
  });
  return taken.count === 1;
}

/** The worker reports how the sign-in it took is going. */
export async function reportLogin(state: "waiting_duo" | "ok" | "failed", note?: string | null) {
  const updated = await prisma.workerStatus.updateMany({
    where: { id: "callink", loginState: { in: ["running", "waiting_duo"] } },
    data: { loginState: state, loginUpdatedAt: new Date(), loginNote: note?.slice(0, 500) ?? null },
  });
  return { updated: updated.count };
}

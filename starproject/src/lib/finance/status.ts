import type { ReimbursementStatus } from "@prisma/client";

// Who may move a reimbursement between statuses. "owner" is the member who filed
// it in STARProject; "worker" is callink-worker through the worker API.
export type Actor = "admin" | "owner" | "worker";

const TRANSITIONS: Record<ReimbursementStatus, Partial<Record<ReimbursementStatus, Actor[]>>> = {
  pending_approval: { approved: ["admin"], rejected: ["admin"], cancelled: ["admin", "owner"] },
  approved: { submitting: ["worker"], cancelled: ["admin"] },
  // submitting -> approved is the worker releasing a dry run.
  submitting: { submitted: ["worker"], failed: ["worker"], approved: ["worker"] },
  failed: { approved: ["admin"], cancelled: ["admin"] },
  submitted: {},
  rejected: {},
  cancelled: {},
};

export function canTransition(from: ReimbursementStatus, to: ReimbursementStatus, actors: Actor[]): boolean {
  const allowed = TRANSITIONS[from][to];
  return !!allowed && allowed.some((a) => actors.includes(a));
}

export const STATUS_LABEL: Record<ReimbursementStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved, queued",
  submitting: "Filing on CalLink",
  submitted: "On CalLink",
  failed: "Filing failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export type Tone = "slate" | "blue" | "amber" | "green" | "red" | "violet";

export const TONE_BADGE: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  green: "bg-green-100 text-green-700 dark:bg-green-400/15 dark:text-green-300",
  red: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
};

// CalLink's own statuses, once a request is on CalLink.
const CALLINK: Record<string, { label: string; tone: Tone }> = {
  Unapproved: { label: "Awaiting CalLink approval", tone: "blue" },
  Approved: { label: "Approved on CalLink", tone: "green" },
  Completed: { label: "Completed", tone: "green" },
  Denied: { label: "Denied on CalLink", tone: "red" },
  Canceled: { label: "Cancelled on CalLink", tone: "slate" },
};

/**
 * The one status a member sees: ours until the request is on CalLink, CalLink's
 * after. The value doubles as the status filter's key.
 */
export function displayStatus(r: {
  status: ReimbursementStatus;
  callinkStatus: string | null;
  callinkDeletedOn: Date | string | null;
  needsCheck: boolean;
}): { key: string; label: string; tone: Tone } {
  if (r.needsCheck) return { key: "needs_check", label: "Needs check", tone: "red" };
  if (r.status === "submitted") {
    if (r.callinkDeletedOn) return { key: "callink:Deleted", label: "Deleted on CalLink", tone: "slate" };
    const c = r.callinkStatus ? CALLINK[r.callinkStatus] : undefined;
    if (c) return { key: `callink:${r.callinkStatus}`, ...c };
    return { key: "submitted", label: r.callinkStatus ?? STATUS_LABEL.submitted, tone: "blue" };
  }
  const tone: Record<ReimbursementStatus, Tone> = {
    pending_approval: "amber",
    approved: "violet",
    submitting: "violet",
    submitted: "blue",
    failed: "red",
    rejected: "red",
    cancelled: "slate",
  };
  return { key: r.status, label: STATUS_LABEL[r.status], tone: tone[r.status] };
}

/** Statuses an admin has to act on. */
export function needsAdmin(r: { status: ReimbursementStatus; needsCheck: boolean }): boolean {
  return r.status === "pending_approval" || r.status === "failed" || r.needsCheck;
}

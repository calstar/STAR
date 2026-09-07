import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";

export type ActivityKind =
  | "created"
  | "deleted"
  | "updated"
  | "assigned"
  | "unassigned"
  | "blocker_added"
  | "blocker_removed";

export type ActivityInput = {
  actorId: string;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  field?: string;
  from?: string | null;
  to?: string | null;
};

/** Append one row to the audit log. Called inline (awaited) inside actions. */
export async function recordActivity(a: ActivityInput): Promise<void> {
  await prisma.activity.create({
    data: {
      actorId: a.actorId,
      taskId: a.taskId,
      projectId: a.projectId,
      taskTitle: a.taskTitle,
      kind: a.kind,
      field: a.field ?? null,
      fromValue: a.from ?? null,
      toValue: a.to ?? null,
    },
  });
}

// Human-readable snapshot renderers (stored at write time).
export function userLabel(
  u: { name: string | null; email: string; displayName: string | null } | null,
): string {
  return u ? displayNameOf(u) : "Unassigned";
}
/** The assignee set, as a comma-joined list of display names (or "Unassigned"). */
export function usersLabel(
  us: { name: string | null; email: string; displayName: string | null }[],
): string {
  return us.length ? us.map((u) => displayNameOf(u)).join(", ") : "Unassigned";
}
export function dateLabel(d: Date | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "no date";
}
export function priorityLabel(p: string | null): string {
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "None";
}
export function subteamLabel(name: string | null | undefined): string {
  return name ?? "No subteam";
}

// Re-exported so server-side importers (feed, digest) keep their `@/lib/activity`
// import; the source of truth is the prisma-free module shared with the client.
export { FIELD_LABEL } from "@/lib/activity-labels";

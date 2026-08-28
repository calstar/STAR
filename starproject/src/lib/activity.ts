import { prisma } from "@/lib/db";

export type ActivityKind =
  | "created"
  | "deleted"
  | "updated"
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
  u: { name: string | null; email: string } | null,
): string {
  return u ? (u.name ?? u.email) : "Unassigned";
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

// For the feed: "changed {FIELD_LABEL[field]} of …"
export const FIELD_LABEL: Record<string, string> = {
  assignee: "assignee",
  status: "status",
  priority: "priority",
  due: "due date",
  title: "title",
  subteam: "subteam",
};

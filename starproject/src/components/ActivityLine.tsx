import { TaskLink } from "@/components/TaskLink";
import { FIELD_LABEL } from "@/lib/activity-labels";
import { displayNameOf } from "@/lib/names";

// One audit-log row, in the shape both the global feed (server) and the per-task
// history (client popup) query. This module is intentionally prisma-free so it is
// safe to pull into the client bundle from TaskDetail.
export type ActivityItem = {
  id: string;
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  taskTitle: string;
  taskId: string | null;
  projectId: string | null;
  createdAt: Date;
  actor: { name: string | null; email: string; displayName: string | null };
};

export function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(d).toISOString().slice(0, 10);
}

function taskRef(a: ActivityItem) {
  if (a.taskId && a.projectId)
    return (
      <TaskLink
        projectId={a.projectId}
        taskId={a.taskId}
        className="font-medium hover:underline"
      >
        {a.taskTitle}
      </TaskLink>
    );
  return <span className="font-medium">“{a.taskTitle}”</span>;
}

function bold(s: string | null) {
  return <span className="font-medium">{s ?? "—"}</span>;
}

/**
 * Render an activity row as a sentence. `withTask` (default true) includes a
 * reference to the task — the global feed wants it; the per-task popup history
 * omits it (the task is already the context).
 */
export function renderActivity(
  a: ActivityItem,
  opts: { withTask?: boolean } = {},
) {
  const withTask = opts.withTask ?? true;
  const who = <span className="font-medium">{displayNameOf(a.actor)}</span>;
  switch (a.kind) {
    case "created":
      return withTask ? <>{who} created {taskRef(a)}</> : <>{who} created this task</>;
    case "deleted":
      return withTask ? (
        <>{who} deleted task {taskRef(a)}</>
      ) : (
        <>{who} deleted this task</>
      );
    case "assigned":
      return withTask ? (
        <>{who} assigned {bold(a.toValue)} to {taskRef(a)}</>
      ) : (
        <>{who} assigned {bold(a.toValue)}</>
      );
    case "unassigned":
      return withTask ? (
        <>{who} unassigned {bold(a.toValue)} from {taskRef(a)}</>
      ) : (
        <>{who} unassigned {bold(a.toValue)}</>
      );
    case "blocker_added":
      return withTask ? (
        <>{who} added a blocker to {taskRef(a)}: {bold(a.toValue)}</>
      ) : (
        <>{who} added a blocker: {bold(a.toValue)}</>
      );
    case "blocker_removed":
      return withTask ? (
        <>{who} removed a blocker from {taskRef(a)}: {bold(a.toValue)}</>
      ) : (
        <>{who} removed a blocker: {bold(a.toValue)}</>
      );
    case "updated":
      return (
        <>
          {who} changed {FIELD_LABEL[a.field ?? ""] ?? a.field}
          {withTask ? <> of {taskRef(a)}</> : null} from {bold(a.fromValue)} to{" "}
          {bold(a.toValue)}
        </>
      );
    default:
      return withTask ? <>{who} updated {taskRef(a)}</> : <>{who} updated this task</>;
  }
}

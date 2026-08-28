import Link from "next/link";

import { FIELD_LABEL } from "@/lib/activity";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Item = {
  id: string;
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  taskTitle: string;
  taskId: string | null;
  projectId: string | null;
  createdAt: Date;
  actor: { name: string | null; email: string };
};

function timeAgo(d: Date): string {
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

function taskRef(a: Item) {
  if (a.taskId && a.projectId)
    return (
      <Link
        href={`/projects/${a.projectId}/tasks/${a.taskId}`}
        className="font-medium hover:underline"
      >
        {a.taskTitle}
      </Link>
    );
  return <span className="font-medium">“{a.taskTitle}”</span>;
}

function bold(s: string | null) {
  return <span className="font-medium">{s ?? "—"}</span>;
}

function renderActivity(a: Item) {
  const who = <span className="font-medium">{a.actor.name ?? a.actor.email}</span>;
  switch (a.kind) {
    case "created":
      return (
        <>
          {who} created {taskRef(a)}
        </>
      );
    case "deleted":
      return (
        <>
          {who} deleted task {taskRef(a)}
        </>
      );
    case "blocker_added":
      return (
        <>
          {who} added a blocker to {taskRef(a)}: {bold(a.toValue)}
        </>
      );
    case "blocker_removed":
      return (
        <>
          {who} removed a blocker from {taskRef(a)}: {bold(a.toValue)}
        </>
      );
    case "updated":
      return (
        <>
          {who} changed {FIELD_LABEL[a.field ?? ""] ?? a.field} of {taskRef(a)}{" "}
          from {bold(a.fromValue)} to {bold(a.toValue)}
        </>
      );
    default:
      return (
        <>
          {who} updated {taskRef(a)}
        </>
      );
  }
}

export default async function ActivityPage() {
  const items = await prisma.activity.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { name: true, email: true } } },
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Activity</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Recent changes across all tasks.
      </p>
      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        {items.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">No activity yet.</li>
        )}
        {items.map((a) => (
          <li
            key={a.id}
            className="flex items-start justify-between gap-4 p-3 text-sm"
          >
            <span className="text-neutral-700 dark:text-neutral-200">{renderActivity(a)}</span>
            <span className="shrink-0 text-xs text-neutral-400">
              {timeAgo(a.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

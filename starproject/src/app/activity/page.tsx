import Link from "next/link";

import { ActivityFilters } from "@/components/ActivityFilters";
import { TaskLink } from "@/components/TaskLink";
import { FIELD_LABEL } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

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
  actor: { name: string | null; email: string; displayName: string | null };
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

function renderActivity(a: Item) {
  const who = <span className="font-medium">{displayNameOf(a.actor)}</span>;
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

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    kind?: string;
    actor?: string;
    project?: string;
  }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const kind = sp.kind ?? "";
  const actor = sp.actor ?? "";
  const project = sp.project ?? "";

  const where = {
    ...(kind ? { kind } : {}),
    ...(actor ? { actorId: actor } : {}),
    ...(project ? { projectId: project } : {}),
  };

  const [items, total, users, projects] = await Promise.all([
    prisma.activity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { actor: { select: { name: true, email: true, displayName: true } } },
    }),
    prisma.activity.count({ where }),
    getTeamUsers(),
    prisma.project.findMany({
      where: { archived: false },
      select: { id: true, name: true, parent: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const projectOptions = projects.map((p) => ({
    id: p.id,
    label: p.parent ? `${p.parent.name} › ${p.name}` : p.name,
  }));

  // Build a page URL that preserves the active filters.
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (kind) q.set("kind", kind);
    if (actor) q.set("actor", actor);
    if (project) q.set("project", project);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/activity?${s}` : "/activity";
  };

  const pageBtn =
    "rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800";
  const pageBtnDisabled =
    "rounded border border-neutral-200 px-3 py-1 text-sm text-neutral-400 dark:border-neutral-800 dark:text-neutral-600";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Activity</h1>

      <ActivityFilters
        users={users}
        projects={projectOptions}
        kind={kind}
        actor={actor}
        project={project}
      />

      <ul className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        {items.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No activity matches.
          </li>
        )}
        {items.map((a) => (
          <li
            key={a.id}
            className="flex items-start justify-between gap-4 p-3 text-sm"
          >
            <span className="text-neutral-700 dark:text-neutral-200">
              {renderActivity(a)}
            </span>
            <span className="shrink-0 text-xs text-neutral-400">
              {timeAgo(a.createdAt)}
            </span>
          </li>
        ))}
      </ul>

      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
          <span>
            Page {page} of {totalPages} · {total} event{total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className={pageBtn}>
                ← Prev
              </Link>
            ) : (
              <span className={pageBtnDisabled}>← Prev</span>
            )}
            {page < totalPages ? (
              <Link href={pageHref(page + 1)} className={pageBtn}>
                Next →
              </Link>
            ) : (
              <span className={pageBtnDisabled}>Next →</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

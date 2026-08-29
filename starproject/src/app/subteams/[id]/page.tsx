import Link from "next/link";
import { notFound } from "next/navigation";

import { Board } from "@/components/Board";
import { GanttChart } from "@/components/GanttChart";
import { TaskRow } from "@/components/TaskRow";
import { isAdmin } from "@/lib/admins";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

type View = "board" | "list" | "gantt";

export default async function SubteamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const { view: rawView } = await searchParams;
  const view: View =
    rawView === "list" ? "list" : rawView === "gantt" ? "gantt" : "board";

  const [subteam, users] = await Promise.all([
    prisma.subteam.findUnique({
      where: { id },
      include: {
        tasks: {
          include: {
            assignee: true,
            blockedBy: {
              include: {
                blockedByTask: { select: { id: true, title: true, status: true } },
              },
            },
          },
          orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    }),
    getTeamUsers(),
  ]);

  if (!subteam) notFound();
  const admin = isAdmin((await getCurrentUser()).email);

  const th = "px-2 py-2 font-medium";
  const tab = (active: boolean) =>
    `rounded px-3 py-1 text-sm ${
      active
        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:hover:bg-neutral-800"
    }`;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className="inline-block h-4 w-4 rounded-full"
            style={{ background: subteam.color ?? "#a3a3a3" }}
          />
          <h1 className="text-2xl font-semibold">{subteam.name}</h1>
          <span className="rounded-full border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            subteam
          </span>
        </div>
        <Link
          href="/subteams"
          className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
        >
          ← All subteams
        </Link>
      </div>

      <div className="mt-6 flex items-center gap-1">
        <Link href={`/subteams/${subteam.id}`} className={tab(view === "board")}>
          Board
        </Link>
        <Link
          href={`/subteams/${subteam.id}?view=list`}
          className={tab(view === "list")}
        >
          List
        </Link>
        <Link
          href={`/subteams/${subteam.id}?view=gantt`}
          className={tab(view === "gantt")}
        >
          Timeline
        </Link>
      </div>

      {subteam.tasks.length === 0 ? (
        <p className="mt-6 text-neutral-500 dark:text-neutral-400">
          No tasks are tagged with this subteam yet. Set a task&apos;s subteam to
          “{subteam.name}” to see it here.
        </p>
      ) : view === "list" ? (
        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                <th className={th}>Task</th>
                <th className={th}>Status</th>
                <th className={th}>Priority</th>
                <th className={th}>Assignee</th>
                <th className={th}>Due</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {subteam.tasks.map((t) => (
                <TaskRow key={t.id} task={t} users={users} isAdmin={admin} />
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "gantt" ? (
        <div className="mt-6">
          <GanttChart tasks={subteam.tasks} />
        </div>
      ) : (
        <div className="mt-6">
          <Board tasks={subteam.tasks} />
        </div>
      )}
    </div>
  );
}

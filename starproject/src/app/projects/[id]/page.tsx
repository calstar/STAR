import Link from "next/link";
import { notFound } from "next/navigation";

import { Board } from "@/components/Board";
import { GanttChart } from "@/components/GanttChart";
import { NewTaskForm } from "@/components/NewTaskForm";
import { TaskRow } from "@/components/TaskRow";
import { deleteProject } from "@/lib/actions/projects";
import { isAdmin } from "@/lib/admins";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSubteams } from "@/lib/subteams";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

type View = "board" | "list" | "gantt";

export default async function ProjectPage({
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

  const [project, users, subteams] = await Promise.all([
    prisma.project.findUnique({
      where: { id },
      include: {
        parent: { select: { id: true, name: true } },
        children: {
          where: { archived: false },
          select: { id: true, name: true, color: true },
          orderBy: { createdAt: "desc" },
        },
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
    getSubteams(),
  ]);

  if (!project) notFound();

  const admin = isAdmin((await getCurrentUser()).email);
  const th = "px-2 py-2 font-medium";
  const tab = (active: boolean) =>
    `rounded px-3 py-1 text-sm ${
      active
        ? "bg-neutral-900 text-white"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100"
    }`;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          {project.parent && (
            <div className="mb-1 text-sm text-neutral-500 dark:text-neutral-400">
              <Link
                href={`/projects/${project.parent.id}`}
                className="hover:underline"
              >
                {project.parent.name}
              </Link>
              <span className="mx-1">›</span>
              <span>{project.name}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ background: project.color ?? "#a3a3a3" }}
            />
            <h1 className="text-2xl font-semibold">{project.name}</h1>
          </div>
          {project.description && (
            <p className="mt-1 text-neutral-600 dark:text-neutral-300">{project.description}</p>
          )}
          {project.children.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Subprojects
              </span>
              {project.children.map((c) => (
                <Link
                  key={c.id}
                  href={`/projects/${c.id}`}
                  className="flex items-center gap-1.5 rounded-full border border-neutral-300 dark:border-neutral-700 px-2.5 py-0.5 text-sm hover:bg-neutral-100"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: c.color ?? "#a3a3a3" }}
                  />
                  {c.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Link href="/" className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline">
            ← All projects
          </Link>
          {admin && (
            <form action={deleteProject}>
              <input type="hidden" name="id" value={project.id} />
              <button className="text-sm text-red-600 hover:underline">
                Delete project
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-1">
        <Link href={`/projects/${project.id}`} className={tab(view === "board")}>
          Board
        </Link>
        <Link
          href={`/projects/${project.id}?view=list`}
          className={tab(view === "list")}
        >
          List
        </Link>
        <Link
          href={`/projects/${project.id}?view=gantt`}
          className={tab(view === "gantt")}
        >
          Timeline
        </Link>
      </div>

      <div className="mt-4">
        <NewTaskForm projectId={project.id} users={users} subteams={subteams} />
      </div>

      {view === "list" ? (
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
              {project.tasks.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-neutral-500 dark:text-neutral-400">
                    No tasks yet. Add one above.
                  </td>
                </tr>
              )}
              {project.tasks.map((t) => (
                <TaskRow key={t.id} task={t} users={users} isAdmin={admin} />
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "gantt" ? (
        <div className="mt-6">
          <GanttChart tasks={project.tasks} />
        </div>
      ) : (
        <div className="mt-6">
          <Board tasks={project.tasks} />
        </div>
      )}
    </div>
  );
}

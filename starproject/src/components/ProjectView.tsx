import Link from "next/link";
import { notFound } from "next/navigation";

import { DetailView, type DetailViewMode } from "@/components/DetailView";
import { NewTaskForm } from "@/components/NewTaskForm";
import { isAdmin } from "@/lib/admins";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSubteams } from "@/lib/subteams";
import { getTeamUsers } from "@/lib/user";

export type ProjectViewMode = DetailViewMode;

// The project detail body. Rendered both as the project page and as the backdrop
// behind a task modal. Builds the project-specific header and hands the shared
// tabs + task views to <DetailView>.
export async function ProjectView({
  id,
  view,
}: {
  id: string;
  view: ProjectViewMode;
}) {
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
      },
    }),
    getTeamUsers(),
    getSubteams(),
  ]);

  if (!project) notFound();

  // A parent project shows its own tasks plus every subproject's tasks; each
  // task keeps its own projectId (so it opens in its own project) and carries a
  // `subproject` tag when it isn't the parent's own.
  const projectIds = [project.id, ...project.children.map((c) => c.id)];
  const rawTasks = await prisma.task.findMany({
    where: { projectId: { in: projectIds } },
    include: {
      assignee: true,
      blockedBy: {
        include: {
          blockedByTask: { select: { id: true, title: true, status: true } },
        },
      },
      project: { select: { name: true, color: true } },
      subteam: { select: { name: true } },
    },
    orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
  });
  const tasks = rawTasks.map((t) => ({
    ...t,
    projectName: t.project.name,
    subteamName: t.subteam?.name ?? "",
    assigneeName: t.assignee?.name ?? t.assignee?.email ?? "",
    subproject:
      t.projectId === project.id
        ? null
        : { name: t.project.name, color: t.project.color },
  }));

  const admin = isAdmin((await getCurrentUser()).email);

  const header = (
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
          <p className="mt-1 text-neutral-600 dark:text-neutral-300">
            {project.description}
          </p>
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
                className="flex items-center gap-1.5 rounded-full border border-neutral-300 dark:border-neutral-700 px-2.5 py-0.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
      <Link
        href="/projects"
        className="shrink-0 text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
      >
        ← All projects
      </Link>
    </div>
  );

  return (
    <DetailView
      basePath={`/projects/${project.id}`}
      view={view}
      tasks={tasks}
      users={users}
      admin={admin}
      header={header}
      showSubteam
      newTaskForm={
        <NewTaskForm projectId={project.id} users={users} subteams={subteams} />
      }
    />
  );
}

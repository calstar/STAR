import Link from "next/link";
import { notFound } from "next/navigation";

import { DetailView, type DetailViewMode } from "@/components/DetailView";
import { NewTaskForm } from "@/components/NewTaskForm";
import { isAdmin } from "@/lib/admins";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function SubteamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const { view: rawView } = await searchParams;
  const view: DetailViewMode =
    rawView === "board" ? "board" : rawView === "gantt" ? "gantt" : "list";

  const [subteam, users, projects] = await Promise.all([
    prisma.subteam.findUnique({
      where: { id },
      include: {
        tasks: {
          where: { archived: false },
          include: {
            assignees: {
              select: { id: true, name: true, email: true, displayName: true },
            },
            blockedBy: {
              include: {
                blockedByTask: { select: { id: true, title: true, status: true } },
              },
            },
            project: { select: { name: true, color: true } },
          },
          orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
        },
      },
    }),
    getTeamUsers(),
    prisma.project.findMany({
      where: { archived: false },
      select: { id: true, name: true, parent: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!subteam) notFound();
  const admin = await isAdmin((await getCurrentUser()).email);

  // A subteam's tasks span projects; tag each with its project so the list/board
  // shows where it lives (reusing the same chip subprojects use in a parent).
  const tasks = subteam.tasks.map((t) => ({
    ...t,
    projectName: t.project.name,
    subteamName: subteam.name,
    assigneeName: t.assignees.map((a) => displayNameOf(a)).join(", "),
    subproject: { name: t.project.name, color: t.project.color },
  }));

  const projectOptions = projects.map((p) => ({
    id: p.id,
    label: p.parent ? `${p.parent.name} › ${p.name}` : p.name,
  }));

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-4 w-4 rounded-full"
          style={{ background: subteam.color ?? "#a3a3a3" }}
        />
        <h1 className="text-2xl font-semibold">{subteam.name}</h1>
      </div>
      <Link
        href="/subteams"
        className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
      >
        ← All subteams
      </Link>
    </div>
  );

  return (
    <DetailView
      basePath={`/subteams/${subteam.id}`}
      view={view}
      tasks={tasks}
      users={users}
      admin={admin}
      header={header}
      showProject
      newTaskForm={
        <NewTaskForm subteamId={subteam.id} projects={projectOptions} users={users} />
      }
      emptyText={`No tasks are tagged with “${subteam.name}” yet. Add one above or set a task's subteam to this one.`}
    />
  );
}

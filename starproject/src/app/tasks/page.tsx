import {
  TasksWorkspace,
  type WorkspaceTask,
} from "@/components/TasksWorkspace";
import { prisma } from "@/lib/db";
import { getSubteams } from "@/lib/subteams";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ subteam?: string }>;
}) {
  const { subteam } = await searchParams;

  const [raw, projects, subteams, me] = await Promise.all([
    prisma.task.findMany({
      include: {
        project: {
          select: { id: true, name: true, parent: { select: { name: true } } },
        },
        subteam: { select: { id: true, name: true } },
        assignee: true,
        blockedBy: {
          include: {
            blockedByTask: { select: { id: true, title: true, status: true } },
          },
        },
      },
      orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.project.findMany({
      where: { archived: false },
      select: { id: true, name: true, parent: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    getSubteams(),
    getCurrentDbUser(),
  ]);

  const tasks: WorkspaceTask[] = raw.map((t) => {
    const { project, subteam: sub, ...rest } = t;
    return {
      ...rest,
      projectName: project.parent
        ? `${project.parent.name} › ${project.name}`
        : project.name,
      subteamName: sub?.name ?? "",
      assigneeName: t.assignee?.name ?? t.assignee?.email ?? "",
    };
  });

  const projectOptions = projects.map((p) => ({
    id: p.id,
    label: p.parent ? `${p.parent.name} › ${p.name}` : p.name,
  }));

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <p className="mt-1 text-sm text-neutral-500">
        All tasks across every project.
      </p>
      <div className="mt-6">
        <TasksWorkspace
          tasks={tasks}
          projects={projectOptions}
          subteams={subteams}
          currentUserId={me.id}
          initialSubteam={subteam}
        />
      </div>
    </div>
  );
}

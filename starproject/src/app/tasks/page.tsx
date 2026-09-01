import { NewTaskForm } from "@/components/NewTaskForm";
import {
  TasksWorkspace,
  type WorkspaceTask,
} from "@/components/TasksWorkspace";
import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getSubteams } from "@/lib/subteams";
import { getCurrentDbUser, getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ subteam?: string; mine?: string }>;
}) {
  const { subteam, mine } = await searchParams;

  const [raw, projects, subteams, me, users] = await Promise.all([
    prisma.task.findMany({
      include: {
        project: {
          select: { id: true, name: true, parent: { select: { name: true } } },
        },
        subteam: { select: { id: true, name: true } },
        assignees: {
          select: { id: true, name: true, email: true, displayName: true },
        },
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
    getTeamUsers(),
  ]);

  const tasks: WorkspaceTask[] = raw.map((t) => {
    const { project, subteam: sub, ...rest } = t;
    return {
      ...rest,
      projectName: project.parent
        ? `${project.parent.name} › ${project.name}`
        : project.name,
      subteamName: sub?.name ?? "",
      assigneeName: t.assignees.map((a) => displayNameOf(a)).join(", "),
    };
  });

  const projectOptions = projects.map((p) => ({
    id: p.id,
    label: p.parent ? `${p.parent.name} › ${p.name}` : p.name,
  }));

  return (
    <div className="mx-auto max-w-[88rem] px-6 py-8">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <div className="mt-6">
        <NewTaskForm
          projects={projectOptions}
          users={users}
          subteams={subteams}
        />
      </div>
      <div className="mt-4">
        <TasksWorkspace
          tasks={tasks}
          projects={projectOptions}
          subteams={subteams}
          users={users}
          admin={await isAdmin(me.email)}
          currentUserId={me.id}
          initialSubteam={subteam}
          initialMine={mine === "1"}
        />
      </div>
    </div>
  );
}

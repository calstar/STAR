import { NewTaskForm } from "@/components/NewTaskForm";
import {
  TasksWorkspace,
  type WorkspaceTask,
} from "@/components/TasksWorkspace";
import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { flatten, pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getSubteams } from "@/lib/subteams";
import { getCurrentDbUser, getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ subteam?: string; mine?: string; project?: string }>;
}) {
  // `project` may list several ids (comma-separated) — the homepage links a
  // subteam's card to its tasks across every project on that card.
  const { subteam, mine, project } = await searchParams;

  const [raw, tree, subteams, me, users] = await Promise.all([
    prisma.task.findMany({
      include: {
        project: { select: { id: true, name: true } },
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
    getProjectTree(),
    getSubteams(),
    getCurrentDbUser(),
    getTeamUsers(),
  ]);

  const tasks: WorkspaceTask[] = raw.map((t) => {
    const { project, subteam: sub, ...rest } = t;
    return {
      ...rest,
      projectName: pathOf(tree, project.id) || project.name,
      subteamName: sub?.name ?? "",
      assigneeName: t.assignees.map((a) => displayNameOf(a)).join(", "),
    };
  });

  const projectOptions = flatten(tree).map(({ node }) => ({
    id: node.id,
    label: pathOf(tree, node.id),
  }));

  return (
    <div className="mx-auto max-w-[88rem] px-4 sm:px-6 py-6 sm:py-8">
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
          initialProjects={project?.split(",").filter(Boolean)}
          initialMine={mine === "1"}
        />
      </div>
    </div>
  );
}

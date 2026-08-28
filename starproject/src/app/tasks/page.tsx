import { TaskTable, type TaskRowData } from "@/components/TaskTable";
import { prisma } from "@/lib/db";
import { isBlocked } from "@/lib/tasks";
import { getCurrentDbUser, getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const [tasks, users, projects, me] = await Promise.all([
    prisma.task.findMany({
      include: {
        project: { select: { id: true, name: true } },
        assignee: true,
        blockedBy: {
          include: { blockedByTask: { select: { status: true } } },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    }),
    getTeamUsers(),
    prisma.project.findMany({
      where: { archived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    getCurrentDbUser(),
  ]);

  const rows: TaskRowData[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    projectName: t.project.name,
    status: t.status,
    priority: t.priority ?? "",
    assigneeId: t.assigneeId ?? "",
    assigneeName: t.assignee?.name ?? t.assignee?.email ?? "",
    due: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "",
    overdue:
      !!t.dueDate &&
      t.status !== "done" &&
      new Date(t.dueDate).getTime() < Date.now(),
    blocked: isBlocked(t.blockedBy),
  }));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <p className="mt-1 text-sm text-neutral-500">
        All tasks across every project.
      </p>
      <div className="mt-6">
        <TaskTable
          rows={rows}
          users={users}
          projects={projects}
          currentUserId={me.id}
        />
      </div>
    </div>
  );
}

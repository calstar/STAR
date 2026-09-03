import { prisma } from "@/lib/db";
import { getSubteams } from "@/lib/subteams";
import { getTeamUsers } from "@/lib/user";

/** Shared loader for the task detail view (used by both the full page and the
 * intercepted modal). Returns null if the task doesn't belong to the project. */
export async function getTaskDetailData(projectId: string, taskId: string) {
  const [task, users, siblings, subteams] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            color: true,
            parent: { select: { id: true, name: true } },
          },
        },
        assignees: {
          select: { id: true, name: true, email: true, displayName: true },
        },
        blockedBy: {
          include: {
            blockedByTask: { select: { id: true, title: true, status: true } },
          },
        },
        blocking: {
          include: { task: { select: { id: true, title: true, status: true } } },
        },
      },
    }),
    getTeamUsers(),
    prisma.task.findMany({
      where: { projectId },
      select: { id: true, title: true },
      orderBy: { createdAt: "asc" },
    }),
    getSubteams(),
  ]);

  if (!task || task.projectId !== projectId) return null;

  const existing = new Set(task.blockedBy.map((b) => b.blockedById));
  const candidates = siblings.filter(
    (s) => s.id !== taskId && !existing.has(s.id),
  );
  return { task, users, candidates, subteams };
}

export type TaskDetailData = NonNullable<
  Awaited<ReturnType<typeof getTaskDetailData>>
>;

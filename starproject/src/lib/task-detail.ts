import { prisma } from "@/lib/db";
import { ancestors, flatten, pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getSubteams } from "@/lib/subteams";
import { getTeamUsers } from "@/lib/user";

/** Shared loader for the task detail view (used by both the full page and the
 * intercepted modal). Returns null if the task doesn't belong to the project. */
export async function getTaskDetailData(projectId: string, taskId: string) {
  const [task, users, siblings, subteams, tree] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            color: true,

          },
        },
        assignees: {
          select: { id: true, name: true, email: true, displayName: true },
        },
        createdBy: {
          select: { name: true, email: true, displayName: true },
        },
        activities: {
          orderBy: { createdAt: "desc" },
          include: {
            actor: { select: { name: true, email: true, displayName: true } },
          },
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
      where: { projectId, archived: false },
      select: { id: true, title: true },
      orderBy: { createdAt: "asc" },
    }),
    getSubteams(),
    getProjectTree(),
  ]);

  if (!task || task.projectId !== projectId) return null;

  const existing = new Set(task.blockedBy.map((b) => b.blockedById));
  const candidates = siblings.filter(
    (s) => s.id !== taskId && !existing.has(s.id),
  );
  // Options for moving the task to another project, labelled by full path
  // ("LE4 › Engine › Spark igniter") and in tree order.
  const projects = flatten(tree).map(({ node }) => ({
    id: node.id,
    label: pathOf(tree, node.id),
  }));
  // The task's project's ancestors, root first, for the breadcrumb.
  const projectAncestors = ancestors(tree, task.projectId).map((a) => ({ id: a.id, name: a.name }));
  return { task, users, candidates, subteams, projects, projectAncestors };
}

export type TaskDetailData = NonNullable<
  Awaited<ReturnType<typeof getTaskDetailData>>
>;

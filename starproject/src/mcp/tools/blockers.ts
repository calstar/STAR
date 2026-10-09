import { z } from "zod";

import { addBlockerAction, removeBlocker } from "@/lib/actions/blockers";
import { prisma } from "@/lib/db";
import { descendants } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";

import { IDEMPOTENT_WRITE, READ, WRITE, defineTool, toFormData, type ToolModule } from "./_shared";

// Blocker edges ("task A is blocked by task B"): what the task popup's
// Blocked-by editor adds and removes, and what the Gantt draws arrows from.
// Edges are display-only (blocked badge, arrows); nothing cascades.

const TASK_REF = { id: true, number: true, title: true, status: true, archived: true } as const;

/** The task's Blocked-by and Blocking lists, as the task detail view shows them (src/lib/task-detail.ts). */
async function blockersOf(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      ...TASK_REF,
      projectId: true,
      blockedBy: {
        select: { note: true, createdAt: true, blockedByTask: { select: TASK_REF } },
        orderBy: { createdAt: "asc" },
      },
      blocking: {
        select: { note: true, createdAt: true, task: { select: TASK_REF } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!task) throw new Error("Task not found.");
  const { blockedBy, blocking, ...self } = task;
  return {
    task: self,
    blockedBy: blockedBy.map((b) => ({ task: b.blockedByTask, note: b.note, createdAt: b.createdAt.toISOString() })),
    blocking: blocking.map((b) => ({ task: b.task, note: b.note, createdAt: b.createdAt.toISOString() })),
  };
}

export const blockerTools: ToolModule = (server) => {
  defineTool(
    server,
    "add_blocker",
    {
      description:
        "Mark a task as blocked by another task in the same project, with an optional note (max 300 chars). Rejects a self-block, a cross-project pair, a duplicate and anything that would make a cycle. Same as the Blocked-by editor in the task popup. Returns the task's refreshed blocker lists.",
      inputSchema: {
        taskId: z.string().min(1).describe("The task that is blocked"),
        blockedById: z.string().min(1).describe("The task that blocks it (same project)"),
        note: z.string().trim().max(300).optional().describe("Why it blocks, shown in the Blocked-by list"),
      },
      annotations: WRITE,
    },
    async ({ taskId, blockedById, note }) => {
      // The action returns {error} rather than throwing on a validation
      // failure; a thrown Error here becomes an isError result.
      const state = await addBlockerAction({}, toFormData({ taskId, blockedById, note }));
      if (state.error) throw new Error(state.error);
      return blockersOf(taskId);
    },
  );

  defineTool(
    server,
    "remove_blocker",
    {
      description:
        "Remove the 'taskId is blocked by blockedById' edge. A no-op when there is no such edge. Returns the task's refreshed blocker lists.",
      inputSchema: {
        taskId: z.string().min(1).describe("The blocked task"),
        blockedById: z.string().min(1).describe("The blocking task to unlink"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, blockedById }) => {
      // removeBlocker returns silently when the edge is missing; look first so
      // the caller learns whether anything changed.
      const edge = await prisma.taskBlocker.findUnique({
        where: { taskId_blockedById: { taskId, blockedById } },
        select: { id: true },
      });
      await removeBlocker(toFormData({ taskId, blockedById }));
      return { removed: edge !== null, ...(await blockersOf(taskId)) };
    },
  );

  defineTool(
    server,
    "list_blockers",
    {
      description:
        "Blocker edges. By taskId: what blocks the task and what it blocks (task popup's Blocked-by / Blocking lists). By projectId: every edge among the tasks of that project and its subprojects, the pairs the Gantt draws arrows between. Pass exactly one.",
      inputSchema: {
        taskId: z.string().min(1).optional().describe("A task id"),
        projectId: z.string().min(1).optional().describe("A project id"),
      },
      annotations: READ,
    },
    async ({ taskId, projectId }) => {
      if (!!taskId === !!projectId) throw new Error("Pass exactly one of taskId or projectId.");
      if (taskId) return blockersOf(taskId);

      // Mirrors the Gantt's edge source (src/components/ProjectView.tsx and
      // src/lib/gantt.ts): the blockedBy rows of the project's own tasks and
      // of every project below it. Blockers never cross projects, so filtering
      // on the blocked task's project suffices.
      const [project, tree] = await Promise.all([
        prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } }),
        getProjectTree(),
      ]);
      if (!project) throw new Error("Project not found.");
      const projectIds = [project.id, ...descendants(tree, project.id).map((d) => d.id)];
      const edges = await prisma.taskBlocker.findMany({
        where: { task: { projectId: { in: projectIds } } },
        select: {
          note: true,
          createdAt: true,
          task: { select: TASK_REF },
          blockedByTask: { select: TASK_REF },
        },
        orderBy: { createdAt: "asc" },
      });
      return {
        project,
        projectIds,
        edges: edges.map((e) => ({
          task: e.task,
          blockedBy: e.blockedByTask,
          note: e.note,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  );
};

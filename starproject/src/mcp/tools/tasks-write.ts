import { z } from "zod";

import {
  archiveTask,
  createTask,
  deleteTask,
  moveTask,
  setTaskDates,
  updateTask,
} from "@/lib/actions/tasks";
import { midpointOrder } from "@/lib/board";
import { prisma } from "@/lib/db";
import { descendants } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { TaskPriorityEnum, TaskStatusEnum } from "@/lib/validation";

import { DESTRUCTIVE, IDEMPOTENT_WRITE, WRITE, defineTool, toFormData, type ToolModule } from "./_shared";

// Task writes. Every tool calls the real server action in src/lib/actions/tasks.ts
// so the Activity log, assignment emails and revalidation are the UI's. The
// input→FormData mapping and the board-order arithmetic are pure functions
// (tested in tasks-write.test.ts); the handlers only glue them to the actions.

/** A task date as the UI's <input type="date"> sends it. */
const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("YYYY-MM-DD");

/** What every write hands back: the task as the list/board would show it. */
const taskView = {
  project: { select: { id: true, name: true } },
  subteam: { select: { id: true, name: true } },
  assignees: { select: { id: true, name: true, email: true, displayName: true } },
} as const;

async function readTask(id: string) {
  return prisma.task.findUniqueOrThrow({ where: { id }, include: taskView });
}

// ---------------------------------------------------------------------------
// Pure mappings

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  priority?: z.infer<typeof TaskPriorityEnum>;
  assigneeIds?: string[];
  subteamId?: string;
  startDate?: string;
  dueDate?: string;
};

/** The record `toFormData` turns into what `createTask(formData)` reads. */
export function createTaskFields(input: CreateTaskInput): Record<string, string | string[] | undefined> {
  return {
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    assigneeIds: input.assigneeIds,
    subteamId: input.subteamId,
    startDate: input.startDate,
    dueDate: input.dueDate,
  };
}

export type UpdateTaskInput = {
  taskId: string;
  title?: string;
  description?: string | null;
  blockedNote?: string | null;
  status?: z.infer<typeof TaskStatusEnum>;
  priority?: z.infer<typeof TaskPriorityEnum> | null;
  assigneeIds?: string[];
  subteamId?: string | null;
  projectId?: string;
  startDate?: string | null;
  dueDate?: string | null;
};

/**
 * The record for `updateTask(formData)`. Only keys the caller supplied are
 * present (the action treats presence as "set this field"); `null` stays null so
 * `toFormData` sends "" -- how the UI clears a field.
 */
export function updateTaskFields(input: UpdateTaskInput): Record<string, string | string[] | null | undefined> {
  const { taskId, ...rest } = input;
  const out: Record<string, string | string[] | null | undefined> = { id: taskId };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) out[key] = value as string | string[] | null;
  }
  return out;
}

export type ColumnCard = { id: string; boardOrder: number };

export type MovePlacement = {
  /** Explicit position; wins over the anchors. */
  boardOrder?: number;
  /** Place right after this card in the target column. */
  afterTaskId?: string;
  /** Place right before this card in the target column. */
  beforeTaskId?: string;
};

/**
 * The boardOrder for a card dropped into `column`, exactly as the Board client
 * computes it: the midpoint of the two neighbours it lands between. `column` is
 * the target column in manual order (boardOrder, then createdAt) with the moving
 * card already taken out. No anchor appends to the end.
 */
export function boardOrderFor(column: ColumnCard[], placement: MovePlacement): number {
  if (placement.boardOrder !== undefined) return placement.boardOrder;
  if (placement.afterTaskId !== undefined && placement.beforeTaskId !== undefined)
    throw new Error("Give afterTaskId or beforeTaskId, not both");

  const anchor = placement.afterTaskId ?? placement.beforeTaskId;
  if (anchor === undefined) {
    return midpointOrder(column[column.length - 1]?.boardOrder, undefined);
  }
  const i = column.findIndex((c) => c.id === anchor);
  if (i === -1) throw new Error(`Task ${anchor} is not in the target column`);
  return placement.afterTaskId !== undefined
    ? midpointOrder(column[i].boardOrder, column[i + 1]?.boardOrder)
    : midpointOrder(column[i - 1]?.boardOrder, column[i].boardOrder);
}

// ---------------------------------------------------------------------------
// Tools

export const tasksWriteTools: ToolModule = (server) => {
  defineTool(
    server,
    "create_task",
    {
      description:
        "Create a task in a project (same as the New task form). Logs 'created' and one 'assigned' row per " +
        "assignee, and emails new assignees. Returns the task with its #number.",
      inputSchema: {
        projectId: z.string().min(1),
        title: z.string().trim().min(1).max(300),
        description: z.string().max(5000).optional(),
        priority: TaskPriorityEnum.optional(),
        assigneeIds: z.array(z.string().min(1)).optional().describe("User ids (see whoami / list_users)"),
        subteamId: z.string().min(1).optional(),
        startDate: DateInput.optional(),
        dueDate: DateInput.optional(),
      },
      annotations: WRITE,
    },
    async (input) => {
      const { id } = await createTask(toFormData(createTaskFields(input)));
      const created = await prisma.task.findUnique({ where: { id }, include: taskView });
      if (!created) throw new Error("The task was created but could not be read back");
      return created;
    },
  );

  defineTool(
    server,
    "update_task",
    {
      description:
        "Edit any subset of a task's fields (same as the inline editors). Only the fields you pass change; " +
        "pass null to clear priority, subteam, dates, description or blockedNote. assigneeIds replaces the whole set. " +
        "Moving to done archives the task; moving out of done restores it. Each change is logged.",
      inputSchema: {
        taskId: z.string().min(1),
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(5000).nullable().optional(),
        blockedNote: z.string().max(5000).nullable().optional().describe("Why it is blocked"),
        status: TaskStatusEnum.optional(),
        priority: TaskPriorityEnum.nullable().optional(),
        assigneeIds: z.array(z.string().min(1)).optional().describe("Replaces the assignee set; [] unassigns everyone"),
        subteamId: z.string().min(1).nullable().optional(),
        projectId: z.string().min(1).optional().describe("Move the task to another project"),
        startDate: DateInput.nullable().optional(),
        dueDate: DateInput.nullable().optional(),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async (input) => {
      await updateTask(toFormData(updateTaskFields(input)));
      return readTask(input.taskId);
    },
  );

  defineTool(
    server,
    "set_task_dates",
    {
      description: "Set a task's start and due dates together (what dragging or resizing a Gantt bar does). Logged like any edit.",
      inputSchema: {
        taskId: z.string().min(1),
        startDate: DateInput,
        dueDate: DateInput,
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, startDate, dueDate }) => {
      await setTaskDates(taskId, startDate, dueDate);
      return readTask(taskId);
    },
  );

  defineTool(
    server,
    "move_task",
    {
      description:
        "Kanban move: put a task in a column (status) at a position. Give boardOrder, or afterTaskId / " +
        "beforeTaskId to slot it next to a card in that column of the board you are looking at; with none it goes " +
        "to the end of the column. The board is boardProjectId's (that project plus its subprojects, as the project " +
        "page shows), default the task's own project. status defaults to the task's current column (a reorder). " +
        "A status change is logged.",
      inputSchema: {
        taskId: z.string().min(1),
        status: TaskStatusEnum.optional(),
        boardOrder: z.number().finite().optional(),
        afterTaskId: z.string().min(1).optional(),
        beforeTaskId: z.string().min(1).optional(),
        boardProjectId: z.string().min(1).optional().describe("The project whose board the neighbours are read from"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, status, boardOrder, afterTaskId, beforeTaskId, boardProjectId }) => {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { projectId: true, status: true },
      });
      if (!task) throw new Error("Task not found");
      const target = status ?? task.status;

      let order = boardOrder;
      if (order === undefined) {
        // The target column as the project page lays it out (ProjectView: the
        // board project and everything under it, unarchived, in manual order),
        // minus the moving card -- the Board client removes it before finding
        // its neighbours.
        const boardId = boardProjectId ?? task.projectId;
        const tree = await getProjectTree();
        if (!tree.byId.has(boardId)) throw new Error("boardProjectId: project not found");
        const projectIds = [boardId, ...descendants(tree, boardId).map((p) => p.id)];
        if (!projectIds.includes(task.projectId))
          throw new Error("The task is not shown on that project's board");
        const column = await prisma.task.findMany({
          where: { projectId: { in: projectIds }, status: target, archived: false, id: { not: taskId } },
          orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, boardOrder: true },
        });
        order = boardOrderFor(column, { afterTaskId, beforeTaskId });
      }
      await moveTask(taskId, target, order);
      return readTask(taskId);
    },
  );

  defineTool(
    server,
    "archive_task",
    {
      description:
        "Archive a task (hide it from the active board and lists; it stays in the DB) or, with archived=false, bring it back.",
      inputSchema: {
        taskId: z.string().min(1),
        archived: z.boolean().default(true),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ taskId, archived }) => {
      await archiveTask(taskId, archived);
      return readTask(taskId);
    },
  );

  defineTool(
    server,
    "delete_task",
    {
      description:
        "Permanently delete a task (admins only). Its blocker edges go with it; the Activity log keeps a 'deleted' " +
        "row with the title. Prefer archive_task unless the task was a mistake.",
      inputSchema: { taskId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ taskId }) => {
      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { number: true } });
      if (!task) throw new Error("Task not found");
      await deleteTask(toFormData({ id: taskId }));
      return { deleted: taskId, number: task.number };
    },
  );
};

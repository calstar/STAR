import type { Prisma, TaskStatus } from "@prisma/client";
import { z } from "zod";

import { type BoardSort, type WorkspaceTask, groupByStatus, toRowData } from "@/lib/board";
import { prisma } from "@/lib/db";
import { toGanttTasks } from "@/lib/gantt";
import { displayNameOf } from "@/lib/names";
import { type ProjectTree, descendants, pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getTaskDetailData } from "@/lib/task-detail";
import { getCurrentDbUser } from "@/lib/user";
import { TaskStatusEnum } from "@/lib/validation";

import { READ, defineTool, type ToolModule } from "./_shared";

// Task reads: the /tasks list, a task's detail view, the board and timeline of
// a project or subteam, and the home page's "My tasks". Every tool here runs
// the same Prisma query as the page it stands in for and flattens rows with the
// same pure helpers (`toRowData`, `groupByStatus`, `toGanttTasks`, `pathOf`).
//
// `buildTaskWhere` and `serializeTaskRow` are pure and unit-tested
// (tasks-read.test.ts); the handlers are the only code that touches the DB.

// The include every list-shaped read uses — a superset of /tasks (adds
// project.color for the board's subproject tag) so one serializer fits all.
const TASK_INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  subteam: { select: { id: true, name: true } },
  assignees: { select: { id: true, name: true, email: true, displayName: true } },
  blockedBy: { include: { blockedByTask: { select: { id: true, title: true, status: true } } } },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

const ArchivedEnum = z.enum(["active", "archived", "all"]);
const BoardSortEnum = z.enum(["due", "priority", "created", "title", "manual"]);
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** The filters `list_tasks` takes; the where-clause builder and the in-memory
 * pass share this type. */
export type TaskListFilters = {
  status?: TaskStatus[];
  projectIds?: string[];
  includeSubprojects?: boolean;
  subteamIds?: string[];
  assigneeIds?: string[];
  mine?: boolean;
  archived?: "active" | "archived" | "all";
  search?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  blocked?: boolean;
};

/** The project ids a `projectIds` filter covers: each id plus, by default,
 * everything under it. Archived subprojects join only when archived tasks are
 * wanted (the project page shows active ones). An id the tree doesn't know is
 * an error, as it is for `board`/`gantt`, rather than a silent empty list. */
export function expandProjectIds(
  tree: ProjectTree,
  projectIds: string[],
  opts: { includeSubprojects: boolean; includeArchived: boolean },
): string[] {
  const out = new Set<string>();
  for (const id of projectIds) {
    if (!tree.byId.has(id)) throw new Error(`Project not found: ${id}`);
    out.add(id);
    if (opts.includeSubprojects) {
      for (const d of descendants(tree, id, { includeArchived: opts.includeArchived })) out.add(d.id);
    }
  }
  return [...out];
}

/** The `archived` scope a request means. Done tasks auto-archive
 * (`archivedForStatusChange`), so asking for status `done` without saying
 * which scope reads as "all", like the /tasks page's done section. */
export function effectiveArchived(f: TaskListFilters): "active" | "archived" | "all" {
  return f.archived ?? (f.status?.includes("done") ? "all" : "active");
}

/**
 * The Prisma `where` for `list_tasks`. Only what SQL can answer directly goes
 * here; `search`, `overdue` and `blocked` are applied in memory afterwards by
 * `matchesInMemory`, exactly as TasksWorkspace filters client-side. Date
 * bounds are inclusive calendar days (task dates are stored at UTC midnight).
 */
export function buildTaskWhere(
  f: TaskListFilters,
  ctx: { callerId: string; tree: ProjectTree },
): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {};
  const archived = effectiveArchived(f);
  if (archived !== "all") where.archived = archived === "archived";
  if (f.status?.length) where.status = { in: f.status };
  if (f.projectIds?.length) {
    where.projectId = {
      in: expandProjectIds(ctx.tree, f.projectIds, {
        includeSubprojects: f.includeSubprojects ?? true,
        includeArchived: archived !== "active",
      }),
    };
  }
  if (f.subteamIds?.length) where.subteamId = { in: f.subteamIds };
  // `mine` and `assigneeIds` both narrow by assignee; together they AND.
  const assigneeClauses: Prisma.TaskWhereInput[] = [];
  if (f.assigneeIds?.length) assigneeClauses.push({ assignees: { some: { id: { in: f.assigneeIds } } } });
  if (f.mine) assigneeClauses.push({ assignees: { some: { id: ctx.callerId } } });
  if (assigneeClauses.length) where.AND = assigneeClauses;
  if (f.dueAfter || f.dueBefore) {
    where.dueDate = {
      ...(f.dueAfter ? { gte: new Date(`${f.dueAfter}T00:00:00.000Z`) } : {}),
      ...(f.dueBefore ? { lte: new Date(`${f.dueBefore}T23:59:59.999Z`) } : {}),
    };
  }
  return where;
}

/** The shape every list-style tool returns per task. */
export type SerializedTaskRow = {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: string | null;
  project: { id: string; name: string; path: string };
  subteam: { id: string; name: string } | null;
  assignees: { id: string; displayName: string; email: string }[];
  startDate: string | null;
  dueDate: string | null;
  archived: boolean;
  blocked: boolean;
  overdue: boolean;
  blockedBy: { id: string; title: string; status: TaskStatus }[];
  /** Under a project scope (board/gantt): the task's path below that project
   * when it belongs to a subproject, as the project page tags it. */
  subproject?: { name: string; color: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

function ymd(d: Date | null): string | null {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

/** A raw row as the pages' WorkspaceTask, so the shared helpers apply. The
 * display fields are the ones /tasks computes (project name is the full path). */
export function toWorkspaceTask(t: TaskRow, tree: ProjectTree, below?: string): WorkspaceTask {
  return {
    ...t,
    projectName: pathOf(tree, t.projectId) || t.project.name,
    subteamName: t.subteam?.name ?? "",
    assigneeName: t.assignees.map((a) => displayNameOf(a)).join(", "),
    subproject:
      below && t.projectId !== below
        ? { name: pathOf(tree, t.projectId, below) || t.project.name, color: t.project.color }
        : null,
  };
}

/** Flatten a raw row for the client. `overdue` and `blocked` come from
 * `toRowData`, the same derivation the list table shows. */
export function serializeTaskRow(t: TaskRow, tree: ProjectTree, opts: { below?: string } = {}): SerializedTaskRow {
  const ws = toWorkspaceTask(t, tree, opts.below);
  const row = toRowData(ws);
  const out: SerializedTaskRow = {
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    priority: t.priority ?? null,
    project: { id: t.project.id, name: t.project.name, path: ws.projectName },
    subteam: t.subteam ? { id: t.subteam.id, name: t.subteam.name } : null,
    assignees: t.assignees.map((a) => ({ id: a.id, displayName: displayNameOf(a), email: a.email })),
    startDate: ymd(t.startDate),
    dueDate: ymd(t.dueDate),
    archived: t.archived,
    blocked: row.blocked,
    overdue: row.overdue,
    blockedBy: t.blockedBy.map((b) => b.blockedByTask),
    createdAt: new Date(t.createdAt).toISOString(),
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
  if (opts.below) out.subproject = ws.subproject ?? null;
  return out;
}

/**
 * The filters SQL can't answer: `search` is the same case-insensitive substring
 * over title / project path / subteam / assignee names that TasksWorkspace
 * runs; `overdue` and `blocked` match the badges the table shows.
 */
export function matchesInMemory(row: SerializedTaskRow, f: TaskListFilters): boolean {
  if (f.overdue !== undefined && row.overdue !== f.overdue) return false;
  if (f.blocked !== undefined && row.blocked !== f.blocked) return false;
  if (f.search) {
    const hay = `${row.title} ${row.project.path} ${row.subteam?.name ?? ""} ${row.assignees
      .map((a) => a.displayName)
      .join(", ")}`.toLowerCase();
    if (!hay.includes(f.search.toLowerCase())) return false;
  }
  return true;
}

// A board/gantt scope: one project (with its subtree) or one subteam.
const scopeSchema = {
  projectId: z.string().min(1).optional().describe("A project id; its subprojects are included"),
  subteamId: z.string().min(1).optional().describe("A subteam id (alternative to projectId)"),
};

/** The active tasks of a project subtree (as /projects/[id]) or a subteam (as
 * /subteams/[id]), tagged with the display fields the board and gantt use. */
async function scopedTasks(scope: { projectId?: string; subteamId?: string }) {
  if (!!scope.projectId === !!scope.subteamId) {
    throw new Error("Pass exactly one of projectId or subteamId");
  }
  const tree = await getProjectTree();
  if (scope.projectId) {
    // Mirrors src/components/ProjectView.tsx: the project plus everything below it.
    const project = tree.byId.get(scope.projectId);
    if (!project) throw new Error("Project not found");
    const projectIds = [project.id, ...descendants(tree, project.id).map((d) => d.id)];
    const raw = await prisma.task.findMany({
      where: { projectId: { in: projectIds }, archived: false },
      include: TASK_INCLUDE,
      orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
    });
    return {
      scope: { kind: "project" as const, id: project.id, name: project.name, path: pathOf(tree, project.id) },
      tree,
      below: project.id,
      raw,
    };
  }
  // Mirrors src/app/subteams/[id]/page.tsx: every active task tagged with the subteam.
  const subteam = scope.subteamId
    ? await prisma.subteam.findUnique({ where: { id: scope.subteamId } })
    : null;
  if (!subteam) throw new Error("Subteam not found");
  const raw = await prisma.task.findMany({
    where: { subteamId: subteam.id, archived: false },
    include: TASK_INCLUDE,
    orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
  });
  return { scope: { kind: "subteam" as const, id: subteam.id, name: subteam.name }, tree, below: undefined, raw };
}

export const tasksReadTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_tasks",
    {
      description:
        "List tasks with the /tasks page's filters: status, project (with subprojects), subteam, assignee, " +
        "mine, archived, free-text search, due-date range, overdue, blocked. Returns { total, tasks } " +
        "ordered by board order then creation; page with limit/offset.",
      inputSchema: {
        status: z.array(TaskStatusEnum).optional(),
        projectIds: z.array(z.string().min(1)).optional(),
        includeSubprojects: z.boolean().default(true).describe("Expand projectIds to their subtrees"),
        subteamIds: z.array(z.string().min(1)).optional(),
        assigneeIds: z.array(z.string().min(1)).optional(),
        mine: z.boolean().optional().describe("Only tasks assigned to you"),
        archived: ArchivedEnum.optional().describe(
          "Default 'active'; 'all' when status includes 'done' (done tasks auto-archive)",
        ),
        search: z.string().trim().optional().describe("Substring over title, project path, subteam, assignee names"),
        dueBefore: YMD.optional().describe("Due on or before this day (YYYY-MM-DD)"),
        dueAfter: YMD.optional().describe("Due on or after this day (YYYY-MM-DD)"),
        overdue: z.boolean().optional(),
        blocked: z.boolean().optional().describe("Has an unfinished blocker"),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    async ({ limit, offset, ...filters }) => {
      // Mirrors src/app/tasks/page.tsx (query) and TasksWorkspace (filters).
      const [tree, me] = await Promise.all([getProjectTree(), getCurrentDbUser()]);
      const raw = await prisma.task.findMany({
        where: buildTaskWhere(filters, { callerId: me.id, tree }),
        include: TASK_INCLUDE,
        orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
      });
      const rows = raw.map((t) => serializeTaskRow(t, tree)).filter((r) => matchesInMemory(r, filters));
      return { total: rows.length, tasks: rows.slice(offset, offset + limit) };
    },
  );

  defineTool(
    server,
    "get_task",
    {
      description:
        "One task in full, by id or #number: description, blocked note, dates, assignees, creator, " +
        "blockers both ways, project path and the activity log (newest first).",
      inputSchema: {
        taskId: z.string().min(1).optional(),
        number: z.number().int().positive().optional().describe("The task's #number"),
      },
      annotations: READ,
    },
    async ({ taskId, number }) => {
      if (!!taskId === (number !== undefined)) throw new Error("Pass exactly one of taskId or number");
      const found = await prisma.task.findUnique({
        where: taskId ? { id: taskId } : { number: number as number },
        select: { id: true, projectId: true },
      });
      if (!found) throw new Error("Task not found");
      // Mirrors the task detail page/modal loader; the UI pickers are dropped.
      const data = await getTaskDetailData(found.projectId, found.id);
      if (!data) throw new Error("Task not found");
      const { task, projectAncestors } = data;
      const tree = await getProjectTree();
      const named = <U extends { name: string | null; email: string; displayName: string | null }>(u: U) => ({
        ...u,
        displayName: displayNameOf(u),
      });
      return {
        ...task,
        project: { ...task.project, path: pathOf(tree, task.projectId) || task.project.name },
        projectAncestors,
        assignees: task.assignees.map(named),
        createdBy: named(task.createdBy),
        blocked: task.blockedBy.some((b) => b.blockedByTask.status !== "done"),
        blockedBy: task.blockedBy.map((b) => ({ ...b.blockedByTask, note: b.note, since: b.createdAt })),
        blocking: task.blocking.map((b) => ({ ...b.task, note: b.note, since: b.createdAt })),
        activities: task.activities.map((a) => ({ ...a, actor: named(a.actor) })),
      };
    },
  );

  defineTool(
    server,
    "board",
    {
      description:
        "The kanban board of a project (with its subprojects) or a subteam: active tasks grouped by " +
        "status, each column sorted as the Board view would (default by due date).",
      inputSchema: { ...scopeSchema, sort: BoardSortEnum.default("due") },
      annotations: READ,
    },
    async ({ projectId, subteamId, sort }) => {
      const { scope, tree, below, raw } = await scopedTasks({ projectId, subteamId });
      const byId = new Map(raw.map((t) => [t.id, t]));
      const columns = groupByStatus(
        raw.map((t) => toWorkspaceTask(t, tree, below)),
        sort as BoardSort,
      );
      const out: Record<string, SerializedTaskRow[]> = {};
      for (const [status, tasks] of Object.entries(columns)) {
        out[status] = tasks.map((t) => serializeTaskRow(byId.get(t.id) as TaskRow, tree, { below }));
      }
      return { scope, sort, columns: out };
    },
  );

  defineTool(
    server,
    "gantt",
    {
      description:
        "The timeline of a project (with its subprojects) or a subteam, as the Timeline view draws it: " +
        "dated active tasks with start/end, progress and blocker dependencies, plus the count left off.",
      inputSchema: scopeSchema,
      annotations: READ,
    },
    async ({ projectId, subteamId }) => {
      const { scope, tree, below, raw } = await scopedTasks({ projectId, subteamId });
      return { scope, ...toGanttTasks(raw.map((t) => toWorkspaceTask(t, tree, below))) };
    },
  );

  defineTool(
    server,
    "my_tasks",
    {
      description: "The home page's \"My tasks\": active tasks assigned to you, soonest due first.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      // Mirrors src/app/page.tsx (where/orderBy); the include is the shared row shape.
      const [tree, me] = await Promise.all([getProjectTree(), getCurrentDbUser()]);
      const raw = await prisma.task.findMany({
        where: { archived: false, assignees: { some: { id: me.id } } },
        include: TASK_INCLUDE,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      });
      return { total: raw.length, tasks: raw.map((t) => serializeTaskRow(t, tree)) };
    },
  );
};

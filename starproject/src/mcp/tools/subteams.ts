import { z } from "zod";

import { createSubteam, deleteSubteam, updateSubteam } from "@/lib/actions/subteams";
import { prisma } from "@/lib/db";
import { getProjectTree } from "@/lib/projects";
import { subteamCreateSchema } from "@/lib/validation";

import {
  DESTRUCTIVE,
  IDEMPOTENT_WRITE,
  READ,
  WRITE,
  defineTool,
  toFormData,
  type ToolModule,
} from "./_shared";
import { serializeTaskRow } from "./tasks-read";

// Subteams: the /subteams list, a subteam's page, and the three admin-only
// actions in src/lib/actions/subteams.ts. Subteams are a filtering lens, not
// access control (CLAUDE.md), so the reads are open to everyone; only the
// writes are gated, by the actions themselves.

/** What the /subteams list carries per row, plus the active count the page's
 * detail view would show. */
export type SubteamRow = {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
  /** Every task tagged with the subteam, archived included (the list's badge). */
  taskCount: number;
  /** Tasks not archived -- what /subteams/[id] lists. */
  activeTaskCount: number;
};

type SubteamWithCount = {
  id: string;
  name: string;
  color: string | null;
  createdAt: Date;
  _count: { tasks: number };
};

/** Pure: join the list query's rows with an active-count map (pairs of
 * subteamId → count). A subteam with no active tasks reads 0. */
export function subteamRows(subteams: SubteamWithCount[], active: Map<string, number>): SubteamRow[] {
  return subteams.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    createdAt: new Date(s.createdAt).toISOString(),
    taskCount: s._count.tasks,
    activeTaskCount: active.get(s.id) ?? 0,
  }));
}

// Zod shapes shared with the Workspace setup form (same limits as
// subteamCreateSchema). The form's optional colour is wrapped in a preprocess
// that maps "" to undefined; JSON input has no such ambiguity, so take the
// inner string schema.
const nameSchema = subteamCreateSchema.shape.name;
const colorSchema = subteamCreateSchema.shape.color.innerType().describe("CSS colour, e.g. #6366f1");
const subteamIdSchema = z.string().min(1).describe("Subteam id (from list_subteams)");

async function requireSubteam(id: string): Promise<{ id: string; name: string; color: string | null }> {
  const subteam = await prisma.subteam.findUnique({ where: { id }, select: { id: true, name: true, color: true } });
  if (!subteam) throw new Error(`Subteam not found: ${id}`);
  return subteam;
}

/** Active task counts per subteam, for every subteam that has any. */
async function activeTaskCounts(): Promise<Map<string, number>> {
  const groups = await prisma.task.groupBy({
    by: ["subteamId"],
    where: { archived: false, subteamId: { not: null } },
    _count: { _all: true },
  });
  return new Map(groups.flatMap((g) => (g.subteamId ? [[g.subteamId, g._count._all] as const] : [])));
}

/** One subteam as /subteams lists it (with the active count alongside). */
async function readSubteamRow(id: string): Promise<SubteamRow> {
  const subteam = await prisma.subteam.findUnique({
    where: { id },
    include: { _count: { select: { tasks: true } } },
  });
  if (!subteam) throw new Error(`Subteam not found: ${id}`);
  const active = await prisma.task.count({ where: { subteamId: id, archived: false } });
  return subteamRows([subteam], new Map([[id, active]]))[0];
}

export const subteamTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_subteams",
    {
      description:
        "Every subteam as the /subteams page lists them (by name): id, name, colour, created date, total task count " +
        "and the number of active (unarchived) tasks.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      // Mirrors src/app/subteams/page.tsx: subteams by name with _count.tasks,
      // plus the active count the detail page's list would show.
      const [subteams, active] = await Promise.all([
        prisma.subteam.findMany({
          orderBy: { name: "asc" },
          include: { _count: { select: { tasks: true } } },
        }),
        activeTaskCounts(),
      ]);
      return subteamRows(subteams, active);
    },
  );

  defineTool(
    server,
    "get_subteam",
    {
      description:
        "One subteam with its active tasks as /subteams/{id} shows them: each task's number, title, status, priority, " +
        "due date, project (id, name, colour, path), assignees and blockers, in board order.",
      inputSchema: { subteamId: subteamIdSchema },
      annotations: READ,
    },
    async ({ subteamId }) => {
      // Mirrors src/app/subteams/[id]/page.tsx: the subteam with its
      // unarchived tasks, assignees, blockers and project, ordered like the
      // board. The rows are flattened by the same serializer list_tasks uses.
      const [subteam, tree] = await Promise.all([
        prisma.subteam.findUnique({
          where: { id: subteamId },
          include: {
            tasks: {
              where: { archived: false },
              include: {
                project: { select: { id: true, name: true, color: true } },
                subteam: { select: { id: true, name: true } },
                assignees: { select: { id: true, name: true, email: true, displayName: true } },
                blockedBy: { include: { blockedByTask: { select: { id: true, title: true, status: true } } } },
              },
              orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
            },
          },
        }),
        getProjectTree(),
      ]);
      if (!subteam) throw new Error(`Subteam not found: ${subteamId}`);
      const { tasks, ...row } = subteam;
      return {
        ...row,
        createdAt: new Date(row.createdAt).toISOString(),
        activeTaskCount: tasks.length,
        tasks: tasks.map((t) => {
          const row = serializeTaskRow(t, tree);
          // The page tags each task with its project's colour chip too.
          return { ...row, project: { ...row.project, color: t.project.color } };
        }),
      };
    },
  );

  defineTool(
    server,
    "create_subteam",
    {
      description:
        "Admins only. Create a subteam (name, optional colour), the same as the Workspace setup form. " +
        "Returns the new subteam.",
      inputSchema: { name: nameSchema, color: colorSchema },
      annotations: WRITE,
    },
    async ({ name, color }) => {
      // The action returns nothing and names are not unique, so the new row is
      // found by difference: the rows carrying this (trimmed) name before the
      // call are excluded afterwards. A retry after a timeout therefore gets its
      // own row, and a concurrent create of the same name is reported rather
      // than guessed at.
      const stored = name.trim();
      const before = await prisma.subteam.findMany({ where: { name: stored }, select: { id: true } });
      await createSubteam(toFormData({ name, color }));
      const added = await prisma.subteam.findMany({
        where: { name: stored, id: { notIn: before.map((s) => s.id) } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (added.length === 0) throw new Error("Subteam was not created");
      if (added.length > 1) {
        throw new Error(
          `Created a subteam named "${stored}", but another with that name appeared at the same time; ` +
            `see list_subteams (new ids: ${added.map((s) => s.id).join(", ")})`,
        );
      }
      return readSubteamRow(added[0].id);
    },
  );

  defineTool(
    server,
    "update_subteam",
    {
      description:
        "Admins only. Rename or recolour a subteam. Fields left out are kept. A colour cannot be cleared " +
        "(the subteam form has no way to; color: null is refused), only changed. Returns the refreshed subteam.",
      inputSchema: {
        subteamId: subteamIdSchema,
        name: nameSchema.optional(),
        color: colorSchema.nullable(),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ subteamId, name, color }) => {
      // update_project takes null to clear a colour; the subteam action maps
      // "" to "unchanged", so null here would silently do nothing. Say so.
      if (color === null) {
        throw new Error("A subteam's colour cannot be cleared through the subteam form; pass a colour to change it");
      }
      // The action sets the name from the form every time, so an omitted name
      // is sent back as it is; an omitted colour leaves the stored one alone.
      const current = await requireSubteam(subteamId);
      await updateSubteam(toFormData({ id: subteamId, name: name ?? current.name, color }));
      return readSubteamRow(subteamId);
    },
  );

  defineTool(
    server,
    "delete_subteam",
    {
      description:
        "Admins only. Permanently delete a subteam. Its tasks keep existing with no subteam; its homepage phase rows " +
        "and milestones go with it. Returns the deleted id, name and how many tasks were detached.",
      inputSchema: { subteamId: subteamIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ subteamId }) => {
      const { name } = await requireSubteam(subteamId);
      const tasksDetached = await prisma.task.count({ where: { subteamId } });
      await deleteSubteam(toFormData({ id: subteamId }));
      return { deleted: subteamId, name, tasksDetached };
    },
  );
};

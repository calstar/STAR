import { z } from "zod";

import {
  archiveProject,
  createProjectReturningId,
  deleteProject,
  updateProject,
} from "@/lib/actions/projects";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import {
  ancestors,
  descendants,
  flatten,
  pathOf,
  totalTasks,
  type ProjectTree,
  type TreeNode,
} from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { projectCreateSchema } from "@/lib/validation";

import {
  DESTRUCTIVE,
  IDEMPOTENT_WRITE,
  READ,
  WRITE,
  defineTool,
  toFormData,
  type ToolModule,
} from "./_shared";

// Projects: the /projects list, a project's page header, and the four actions
// in src/lib/actions/projects.ts. The shaping below is pure (tested without a
// database); the tools at the bottom feed it the same queries the pages run.

/** The per-project columns the tree nodes don't carry. */
export type ProjectDetails = {
  description: string | null;
  featured: boolean;
  trackOrder: number;
  phases: string[];
};

export type ProjectRow = TreeNode &
  ProjectDetails & {
    depth: number;
    /** "LE4 › Engine › Spark igniter" */
    path: string;
    /** This project's own tasks. */
    taskCount: number;
    /** Own tasks plus every (non-archived) subproject's, at every level. */
    totalTasks: number;
  };

const NO_DETAILS: ProjectDetails = { description: null, featured: false, trackOrder: 0, phases: [] };

/**
 * The tree in the order src/app/projects/page.tsx lists it: newest top-level
 * project first, each followed by its subprojects (every level, indented) in
 * the order they were made. Archived projects are left out unless asked for.
 */
export function orderedProjectRows(
  tree: ProjectTree,
  opts: { includeArchived?: boolean } = {},
): { node: TreeNode; depth: number }[] {
  const includeArchived = opts.includeArchived ?? false;
  const tops = flatten(tree, { includeArchived })
    .filter((r) => r.depth === 0)
    .reverse();
  return tops.flatMap((top) => [
    top,
    ...flatten(tree, { under: top.node.id, includeArchived }).map((r) => ({
      ...r,
      depth: r.depth + 1,
    })),
  ]);
}

/** One row per project, in page order, with counts rolled up like the page. */
export function projectRows(
  tree: ProjectTree,
  own: Map<string, number>,
  details: Map<string, ProjectDetails>,
  opts: { includeArchived?: boolean } = {},
): ProjectRow[] {
  const ownCount = (id: string) => own.get(id) ?? 0;
  return orderedProjectRows(tree, opts).map(({ node, depth }) => ({
    ...node,
    ...(details.get(node.id) ?? NO_DETAILS),
    depth,
    path: pathOf(tree, node.id),
    taskCount: ownCount(node.id),
    totalTasks: totalTasks(tree, node.id, ownCount),
  }));
}

// Zod shapes shared with the form (same limits as projectCreateSchema). The
// form's optional fields are wrapped in a preprocess that maps "" to undefined;
// JSON input has no such ambiguity, so take the inner string schemas.
const nameSchema = projectCreateSchema.shape.name;
const descriptionSchema = projectCreateSchema.shape.description.innerType();
const colorSchema = projectCreateSchema.shape.color.innerType();
const projectIdSchema = z.string().min(1).describe("Project id (from list_projects)");

async function requireProject(id: string): Promise<{ id: string; name: string }> {
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) throw new Error(`Project not found: ${id}`);
  return project;
}

/** The full project the way its page (src/components/ProjectView.tsx) sees it:
 * the row, its breadcrumb ancestors, its subprojects, counts, who made it. */
async function readProject(id: string, opts: { includeArchived?: boolean } = {}) {
  const [project, tree] = await Promise.all([
    prisma.project.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, email: true, displayName: true } },
        // The page shows active subprojects, newest first.
        children: {
          where: opts.includeArchived ? {} : { archived: false },
          select: { id: true, name: true, color: true, archived: true },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    getProjectTree(),
  ]);
  if (!project) throw new Error(`Project not found: ${id}`);

  // The page's task query spans the project and everything under it.
  const branch = [project.id, ...descendants(tree, project.id).map((d) => d.id)];
  const counts = await prisma.task.groupBy({
    by: ["projectId"],
    where: { projectId: { in: branch } },
    _count: { _all: true },
  });
  const own = new Map(counts.map((c) => [c.projectId, c._count._all]));
  const ownCount = (pid: string) => own.get(pid) ?? 0;

  const { createdBy, children, ...row } = project;
  return {
    ...row,
    path: pathOf(tree, project.id),
    ancestors: ancestors(tree, project.id).map(({ id, name, color }) => ({ id, name, color })),
    children,
    taskCount: ownCount(project.id),
    totalTasks: totalTasks(tree, project.id, ownCount),
    createdBy: { id: createdBy.id, displayName: displayNameOf(createdBy) },
  };
}

export const projectTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_projects",
    {
      description:
        "Every project as the /projects page lists them: newest top-level first, each followed by its subprojects " +
        "(depth, full path, own and rolled-up task counts). Archived projects are hidden unless includeArchived.",
      inputSchema: {
        includeArchived: z.boolean().default(false),
      },
      annotations: READ,
    },
    async ({ includeArchived }) => {
      // Mirrors src/app/projects/page.tsx: the tree, own task counts per
      // project, and the columns the tree nodes don't carry.
      const [tree, counts, details] = await Promise.all([
        getProjectTree(),
        prisma.task.groupBy({ by: ["projectId"], _count: { _all: true } }),
        prisma.project.findMany({
          select: { id: true, description: true, featured: true, trackOrder: true, phases: true },
        }),
      ]);
      const own = new Map(counts.map((c) => [c.projectId, c._count._all]));
      const byId = new Map(details.map(({ id, ...d }) => [id, d]));
      return projectRows(tree, own, byId, { includeArchived });
    },
  );

  defineTool(
    server,
    "get_project",
    {
      description:
        "One project in full: its row, breadcrumb ancestors, subprojects, own and rolled-up task counts, and who created it. " +
        "Subprojects exclude archived ones unless includeArchived.",
      inputSchema: {
        projectId: projectIdSchema,
        includeArchived: z.boolean().default(false),
      },
      annotations: READ,
    },
    async ({ projectId, includeArchived }) => readProject(projectId, { includeArchived }),
  );

  defineTool(
    server,
    "create_project",
    {
      description:
        "Admins only. Create a project, optionally under a parent (projects nest to any depth). Same as the Workspace " +
        "setup form. Returns the new project.",
      inputSchema: {
        name: nameSchema,
        description: descriptionSchema,
        color: colorSchema.describe("CSS colour, e.g. #6366f1"),
        parentId: z.string().min(1).optional().describe("Parent project id for a subproject"),
      },
      annotations: WRITE,
    },
    async ({ name, description, color, parentId }) => {
      const { id } = await createProjectReturningId(toFormData({ name, description, color, parentId }));
      return readProject(id);
    },
  );

  defineTool(
    server,
    "update_project",
    {
      description:
        "Admins only. Edit a project's name, description or colour, or move it under another project " +
        "(parentId null makes it top-level; a move under itself or its own subproject is refused). " +
        "Fields left out are kept; null clears description or colour. Returns the refreshed project.",
      inputSchema: {
        projectId: projectIdSchema,
        name: nameSchema.optional(),
        description: descriptionSchema.nullable(),
        color: colorSchema.nullable(),
        parentId: z.string().min(1).nullable().optional().describe("New parent id, or null for top-level"),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectId, name, description, color, parentId }) => {
      // The action sets name/description/colour from the form every time
      // (omitted = cleared), so an omitted field is sent back as it is. The
      // parent is applied only when the key is present, so it is passed
      // through only when given.
      const current = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, description: true, color: true },
      });
      if (!current) throw new Error(`Project not found: ${projectId}`);
      await updateProject(
        toFormData({
          id: projectId,
          name: name ?? current.name,
          description: description === undefined ? current.description : description,
          color: color === undefined ? current.color : color,
          ...(parentId !== undefined ? { parentId } : {}),
        }),
      );
      return readProject(projectId);
    },
  );

  defineTool(
    server,
    "archive_project",
    {
      description:
        "Admins only. Archive a project (hide it and its subprojects from lists and pickers; its tasks stay), " +
        "or bring it back with archived: false.",
      inputSchema: {
        projectId: projectIdSchema,
        archived: z.boolean().default(true),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ projectId, archived }) => {
      await requireProject(projectId);
      await archiveProject(toFormData({ id: projectId, archived }));
      return readProject(projectId, { includeArchived: true });
    },
  );

  defineTool(
    server,
    "delete_project",
    {
      description:
        "Admins only. Permanently delete a project. Cascades to its tasks (and their activity); subprojects are left behind " +
        "at the top level. Prefer archive_project unless the project was a mistake.",
      inputSchema: { projectId: projectIdSchema },
      annotations: DESTRUCTIVE,
    },
    async ({ projectId }) => {
      const { name } = await requireProject(projectId);
      await deleteProject(toFormData({ id: projectId }));
      return { deleted: projectId, name };
    },
  );
};

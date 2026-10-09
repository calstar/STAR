import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { isAdmin } from "@/lib/admins";
import { runAsIdentity, type CurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { flatten, pathOf, type ProjectTree } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getCurrentDbUser } from "@/lib/user";

// Read-only MCP resources: the things a client wants to pull into context
// without calling a tool. Three URIs (docs/MCP.md "Resources"):
//
//   starproject://projects        the whole project tree, with paths
//   starproject://tasks/{number}  one task by its #number
//   starproject://me              the caller, as whoami reports it
//
// Every body is JSON. The pure shaping functions are exported for the tests;
// `registerResources` wires them to the database and the caller's identity.

export const PROJECTS_URI = "starproject://projects";
export const ME_URI = "starproject://me";
export const TASK_URI_TEMPLATE = "starproject://tasks/{number}";

const JSON_MIME = "application/json";

/** The project tree flattened in display order, archived projects included
 * (flagged) so a task in a retired project still resolves to a full path. */
export function projectTreeJson(tree: ProjectTree) {
  return flatten(tree, { includeArchived: true }).map(({ node, depth }) => ({
    id: node.id,
    name: node.name,
    path: pathOf(tree, node.id),
    depth,
    parentId: node.parentId,
    color: node.color,
    archived: node.archived,
  }));
}

/** The `{number}` of a task URI as an integer. A template variable arrives as
 * a string (or an array for multi-segment expansions, which this URI never
 * has); anything that isn't a positive integer is refused with the raw text. */
export function taskNumberOf(variable: string | string[] | undefined): number {
  const raw = Array.isArray(variable) ? variable[0] : variable;
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Not a task number: ${JSON.stringify(raw ?? null)} (expected starproject://tasks/<positive integer>)`);
  }
  return Number(raw);
}

/** What a task row (as `taskSelect` loads it) looks like on the wire. */
export type TaskRecord = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  blockedNote: string | null;
  status: string;
  priority: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string; archived: boolean };
  subteam: { id: string; name: string } | null;
  assignees: { id: string; email: string; name: string | null; displayName: string | null }[];
  blockedBy: {
    note: string | null;
    blockedByTask: { id: string; number: number; title: string; status: string };
  }[];
};

export function taskJson(task: TaskRecord, projectPath: string) {
  return {
    id: task.id,
    number: task.number,
    title: task.title,
    description: task.description,
    blockedNote: task.blockedNote,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate?.toISOString().slice(0, 10) ?? null,
    dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
    archived: task.archived,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    project: { id: task.project.id, name: task.project.name, path: projectPath, archived: task.project.archived },
    subteam: task.subteam ? { id: task.subteam.id, name: task.subteam.name } : null,
    assignees: task.assignees.map((a) => ({ id: a.id, email: a.email, displayName: displayNameOf(a) })),
    blockedBy: task.blockedBy.map((b) => ({
      taskId: b.blockedByTask.id,
      number: b.blockedByTask.number,
      title: b.blockedByTask.title,
      status: b.blockedByTask.status,
      note: b.note,
    })),
  };
}

const taskSelect = {
  id: true,
  number: true,
  title: true,
  description: true,
  blockedNote: true,
  status: true,
  priority: true,
  startDate: true,
  dueDate: true,
  archived: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true, archived: true } },
  subteam: { select: { id: true, name: true } },
  assignees: { select: { id: true, email: true, name: true, displayName: true } },
  blockedBy: {
    select: {
      note: true,
      blockedByTask: { select: { id: true, number: true, title: true, status: true } },
    },
  },
} as const;

function jsonResource(uri: URL, data: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(data, null, 2) }] };
}

// The bearer identity the route attached as authInfo, re-entered the same way
// defineTool does so `getCurrentDbUser` sees the token's owner.
type Extra = { authInfo?: { extra?: { identity?: CurrentUser } } };

function asCaller<T>(extra: Extra, fn: () => Promise<T>): Promise<T> {
  const identity = extra.authInfo?.extra?.identity;
  return identity ? runAsIdentity(identity, fn) : fn();
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "projects",
    PROJECTS_URI,
    {
      title: "Project tree",
      description: "Every project (archived ones flagged) in tree order with its depth and full path, e.g. 'LE4 › Engine › Spark igniter'.",
      mimeType: JSON_MIME,
    },
    async (uri) => jsonResource(uri, projectTreeJson(await getProjectTree())),
  );

  server.registerResource(
    "task",
    new ResourceTemplate(TASK_URI_TEMPLATE, { list: undefined }),
    {
      title: "Task by number",
      description: "One task by its global #number: fields, project path, subteam, assignees (display names) and what blocks it.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const number = taskNumberOf(variables.number);
      const [task, tree] = await Promise.all([
        prisma.task.findUnique({ where: { number }, select: taskSelect }),
        getProjectTree(),
      ]);
      if (!task) throw new Error(`No task #${number}`);
      return jsonResource(uri, taskJson(task, pathOf(tree, task.project.id)));
    },
  );

  server.registerResource(
    "me",
    ME_URI,
    {
      title: "Who I am",
      description: "The user this token belongs to: id, email, display name, admin flag (same as the whoami tool).",
      mimeType: JSON_MIME,
    },
    async (uri, extra) =>
      asCaller(extra, async () => {
        const user = await getCurrentDbUser();
        return jsonResource(uri, {
          id: user.id,
          email: user.email,
          name: user.name,
          displayName: displayNameOf(user),
          isAdmin: await isAdmin(user.email),
        });
      }),
  );
}

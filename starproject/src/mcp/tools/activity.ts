import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { ActivityKind } from "@/lib/activity";
import { FIELD_LABEL } from "@/lib/activity-labels";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";

import { READ, defineTool, type ToolModule } from "./_shared";

// The audit log, read-only: the /activity feed with its filters and paging,
// and the nightly digest's last-N-hours view. Nothing here writes; every
// mutation elsewhere appends its own row through recordActivity.

/** Every ActivityKind, as a zod enum. Kept in step with the type in src/lib/activity.ts. */
export const ACTIVITY_KINDS = [
  "created",
  "deleted",
  "updated",
  "assigned",
  "unassigned",
  "blocker_added",
  "blocker_removed",
] as const satisfies readonly ActivityKind[];

export type ActivityFilter = {
  kind?: ActivityKind;
  actorId?: string;
  projectId?: string;
  taskId?: string;
  /** Inclusive lower bound on createdAt. */
  since?: Date;
  /** Exclusive upper bound on createdAt. */
  until?: Date;
};

/**
 * The /activity page's where clause (src/app/activity/page.tsx) -- kind, actor,
 * project -- plus a task and a time window the page has no control for. Empty
 * strings and undefined mean "no filter", as the page's `?kind=` does.
 */
export function buildActivityWhere(f: ActivityFilter): Prisma.ActivityWhereInput {
  const where: Prisma.ActivityWhereInput = {};
  if (f.kind) where.kind = f.kind;
  if (f.actorId) where.actorId = f.actorId;
  if (f.projectId) where.projectId = f.projectId;
  if (f.taskId) where.taskId = f.taskId;
  if (f.since || f.until) {
    where.createdAt = {
      ...(f.since ? { gte: f.since } : {}),
      ...(f.until ? { lt: f.until } : {}),
    };
  }
  return where;
}

export type ActivitySummaryInput = {
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  taskTitle: string;
  actor: { name: string | null; email: string; displayName: string | null };
};

/**
 * One activity row as a sentence, word for word what renderActivity in
 * src/components/ActivityLine.tsx shows on the /activity feed (with the task
 * reference rendered as its quoted title and null values as an em dash).
 */
export function activitySummary(a: ActivitySummaryInput): string {
  const who = displayNameOf(a.actor);
  const task = `“${a.taskTitle}”`;
  const val = (s: string | null) => s ?? "—";
  switch (a.kind) {
    case "created":
      return `${who} created ${task}`;
    case "deleted":
      return `${who} deleted task ${task}`;
    case "assigned":
      return `${who} assigned ${val(a.toValue)} to ${task}`;
    case "unassigned":
      return `${who} unassigned ${val(a.toValue)} from ${task}`;
    case "blocker_added":
      return `${who} added a blocker to ${task}: ${val(a.toValue)}`;
    case "blocker_removed":
      return `${who} removed a blocker from ${task}: ${val(a.toValue)}`;
    case "updated":
      return `${who} changed ${FIELD_LABEL[a.field ?? ""] ?? a.field} of ${task} from ${val(a.fromValue)} to ${val(a.toValue)}`;
    default:
      return `${who} updated ${task}`;
  }
}

const ACTOR_SELECT = { id: true, name: true, email: true, displayName: true } as const;

type ActivityRow = Prisma.ActivityGetPayload<{
  include: { actor: { select: typeof ACTOR_SELECT } };
}>;

function toItem(a: ActivityRow) {
  return {
    id: a.id,
    kind: a.kind,
    field: a.field,
    fromValue: a.fromValue,
    toValue: a.toValue,
    taskTitle: a.taskTitle,
    taskId: a.taskId,
    projectId: a.projectId,
    actor: { id: a.actor.id, displayName: displayNameOf(a.actor), email: a.actor.email },
    createdAt: a.createdAt.toISOString(),
    summary: activitySummary(a),
  };
}

/** An ISO-8601 timestamp (or a YYYY-MM-DD date), parsed to a Date. */
const isoDate = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Expected an ISO-8601 date or timestamp")
  .transform((s) => new Date(s));

export const activityTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_activity",
    {
      description:
        "The audit log, newest first, with the /activity page's filters (kind, actor, project) plus task and time window. Paged: page is 1-based, limit defaults to 50 (max 200). Each item carries a human summary line.",
      inputSchema: {
        kind: z.enum(ACTIVITY_KINDS).optional().describe("Only this kind of event"),
        actorId: z.string().min(1).optional().describe("Only events by this user id"),
        projectId: z.string().min(1).optional().describe("Only events on tasks in this project id"),
        taskId: z.string().min(1).optional().describe("Only events on this task id"),
        since: isoDate.optional().describe("Only events at or after this ISO timestamp"),
        until: isoDate.optional().describe("Only events before this ISO timestamp"),
        page: z.number().int().min(1).default(1).describe("1-based page number"),
        limit: z.number().int().min(1).max(200).default(50).describe("Page size, max 200"),
      },
      annotations: READ,
    },
    async ({ kind, actorId, projectId, taskId, since, until, page, limit }) => {
      // Mirrors src/app/activity/page.tsx: same where, orderBy and actor include.
      const where = buildActivityWhere({ kind, actorId, projectId, taskId, since, until });
      const [items, total] = await Promise.all([
        prisma.activity.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: { actor: { select: ACTOR_SELECT } },
        }),
        prisma.activity.count({ where }),
      ]);
      return { total, page, pageSize: limit, items: items.map(toItem) };
    },
  );

  defineTool(
    server,
    "recent_activity",
    {
      description:
        "Everything that happened in the last N hours (default 24, max 168), oldest first: the view the nightly digest email is built from. Optionally only one project or one subteam (a task's subteam at the time of the call).",
      inputSchema: {
        hours: z.number().positive().max(168).default(24).describe("Look back this many hours (max 168)"),
        projectId: z.string().min(1).optional().describe("Only events on tasks in this project id"),
        subteamId: z.string().min(1).optional().describe("Only events on tasks currently in this subteam id"),
        limit: z.number().int().min(1).max(1000).default(200).describe("At most this many events, max 1000"),
      },
      annotations: READ,
    },
    async ({ hours, projectId, subteamId, limit }) => {
      // Mirrors runDigest in src/lib/digest.ts: createdAt >= now - 24h, the
      // task's subteamId and the actor included, oldest first. The digest
      // filters by subscription in memory; here the same two keys are a where.
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const where: Prisma.ActivityWhereInput = {
        ...buildActivityWhere({ projectId, since }),
        ...(subteamId ? { task: { subteamId } } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.activity.findMany({
          where,
          include: {
            task: { select: { subteamId: true } },
            actor: { select: ACTOR_SELECT },
          },
          orderBy: { createdAt: "asc" },
          take: limit,
        }),
        prisma.activity.count({ where }),
      ]);
      return {
        hours,
        since: since.toISOString(),
        total,
        items: items.map((a) => ({ ...toItem(a), subteamId: a.task?.subteamId ?? null })),
      };
    },
  );
};

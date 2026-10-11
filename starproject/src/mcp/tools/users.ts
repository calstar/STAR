import type { TaskStatus } from "@prisma/client";
import { z } from "zod";

import { listAdmins } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getTeamUsers } from "@/lib/user";
import { TaskStatusEnum } from "@/lib/validation";

import { READ, defineTool, type ToolModule } from "./_shared";

// Users: the team as the assignee pickers see it. Reads only -- a user is
// provisioned by signing in (getCurrentDbUser upserts them), there is no
// create, and another person's settings and tokens are theirs alone.

/** The columns every user read returns. Never settings or tokens. */
export type UserSummary = {
  id: string;
  email: string;
  name: string | null;
  /** How the app shows them everywhere (displayNameOf). */
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
  /** Assigned tasks that are active and not done. */
  openTaskCount: number;
};

type UserLike = {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  createdAt: Date;
};

/** The emails of the effective admins, lowercased, for a membership test. */
export function adminEmailSet(admins: { email: string }[]): Set<string> {
  return new Set(admins.map((a) => a.email.toLowerCase()));
}

/** Pure: one user's summary given the admin set and their open-task count. */
export function userSummary(u: UserLike, admins: Set<string>, openTaskCount: number): UserSummary {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    displayName: displayNameOf(u),
    isAdmin: admins.has(u.email.toLowerCase()),
    createdAt: new Date(u.createdAt).toISOString(),
    openTaskCount,
  };
}

/** Pure: a `groupBy status` result as a full map with zeros, so a client can
 * read every status without checking for its presence. */
export function countsByStatus(groups: { status: TaskStatus; _count: { _all: number } }[]): Record<TaskStatus, number> {
  const out = Object.fromEntries(TaskStatusEnum.options.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}

/** What counts as "open" for a person: assigned, active, not done. */
const OPEN_TASK = { archived: false, status: { not: "done" as const } };

/** Pure: pick one user for an email lookup. An exact match wins; otherwise a
 * single case-insensitive match; two or more that differ only by case is an
 * error rather than whichever the database returned first. */
export function pickByEmail<T extends { email: string }>(email: string, matches: T[]): T | null {
  const exact = matches.find((m) => m.email === email);
  if (exact) return exact;
  if (matches.length > 1) {
    throw new Error(`Ambiguous email ${email}: matches ${matches.map((m) => m.email).join(", ")}`);
  }
  return matches[0] ?? null;
}

/** `User.email` is unique only case-sensitively (getCurrentDbUser upserts the
 * header value as given), so look up case-insensitively and disambiguate. */
async function findByEmail(email: string) {
  const matches = await prisma.user.findMany({ where: { email: { equals: email, mode: "insensitive" } } });
  return pickByEmail(email, matches);
}

export const userTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_users",
    {
      description:
        "Everyone who has signed in (the assignee picker's team), by name: id, email, name, display name, " +
        "whether they are an admin, when they first appeared, and how many open tasks they hold.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      // getTeamUsers() is the pickers' list (NewTaskForm, the task detail
      // assignee picker); the open-task counts come from one filtered relation
      // count, and the admin set is computed once for the whole list.
      const [users, admins, counts] = await Promise.all([
        getTeamUsers(),
        listAdmins(),
        prisma.user.findMany({
          select: { id: true, _count: { select: { assignedTasks: { where: OPEN_TASK } } } },
        }),
      ]);
      const adminSet = adminEmailSet(admins);
      const open = new Map(counts.map((c) => [c.id, c._count.assignedTasks]));
      return users.map((u) => userSummary(u, adminSet, open.get(u.id) ?? 0));
    },
  );

  defineTool(
    server,
    "get_user",
    {
      description:
        "One user by userId or email (give exactly one): the same summary as list_users plus their assigned-task counts " +
        "by status (archived included) and how many of those are archived. Never returns settings or tokens.",
      inputSchema: {
        userId: z.string().min(1).optional().describe("User id (from list_users or a task's assignees)"),
        email: z.string().trim().min(1).optional().describe("Email, matched case-insensitively"),
      },
      annotations: READ,
    },
    async ({ userId, email }) => {
      if ((userId ? 1 : 0) + (email ? 1 : 0) !== 1) throw new Error("Give exactly one of userId or email");
      const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : await findByEmail(email!);
      if (!user) throw new Error(`User not found: ${userId ?? email}`);

      const assigned = { assignees: { some: { id: user.id } } };
      const [admins, byStatus, archivedTaskCount, openTaskCount] = await Promise.all([
        listAdmins(),
        prisma.task.groupBy({ by: ["status"], where: assigned, _count: { _all: true } }),
        prisma.task.count({ where: { ...assigned, archived: true } }),
        prisma.task.count({ where: { ...assigned, ...OPEN_TASK } }),
      ]);
      // Every assigned task counts here, archived ones included: done tasks
      // auto-archive, so leaving them out would hide the "done" column.
      const tasksByStatus = countsByStatus(byStatus);
      const assignedTaskCount = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);
      return {
        ...userSummary(user, adminEmailSet(admins), openTaskCount),
        assignedTaskCount,
        archivedTaskCount,
        tasksByStatus,
      };
    },
  );
};

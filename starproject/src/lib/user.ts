import type { User } from "@prisma/client";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * The current viewer as a persisted row. Upserts on every call so anyone who
 * has ever signed in exists in the DB (and thus shows up in assignee pickers) —
 * this is the "users auto-provision" step. Call it wherever an action or page
 * needs the viewer's DB id.
 */
export async function getCurrentDbUser(): Promise<User> {
  const { email, name } = await getCurrentUser();
  // A blank name (a token for a user who has never signed in) must not clobber
  // what the auth header last told us.
  return prisma.user.upsert({
    where: { email },
    create: { email, name: name || null },
    update: name ? { name } : {},
  });
}

/** Everyone who has signed in — the assignable "team". */
export async function getTeamUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: [{ name: "asc" }, { email: "asc" }] });
}

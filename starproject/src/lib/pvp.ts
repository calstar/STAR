import type { User } from "@prisma/client";
import { cache } from "react";

import { prisma } from "@/lib/db";
import { effectiveEmails } from "@/lib/email-roster";
import { getCurrentDbUser } from "@/lib/user";

// PVPs: the people who approve spending. Only a PVP may approve or reject a
// purchase request, or move a BOM line out of Planned (src/lib/actions/bom.ts).
// Kept exactly like the admin list (src/lib/admins.ts): a seed list here, runtime
// additions in PvpEmail, removed seeds tombstoned in RemovedSeedPvp. Any PVP can
// add or remove PVPs (Workspace setup → PVPs), never the last one.
export const SEED_PVP_EMAILS = ["ucberkeleystar@gmail.com"].map((e) => e.toLowerCase());

// Memoized per request, like getAdminEmails.
const getPvpEmails = cache(async (): Promise<Set<string>> => {
  const [added, removed] = await Promise.all([
    prisma.pvpEmail.findMany({ select: { email: true } }),
    prisma.removedSeedPvp.findMany({ select: { email: true } }),
  ]);
  return effectiveEmails(
    SEED_PVP_EMAILS,
    added.map((r) => r.email),
    removed.map((r) => r.email),
  );
});

export async function isPvp(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  return (await getPvpEmails()).has(email.toLowerCase());
}

export async function listPvps(): Promise<{ email: string }[]> {
  const emails = [...(await getPvpEmails())].sort((a, b) => a.localeCompare(b));
  return emails.map((email) => ({ email }));
}

/** The current viewer, if they are a PVP; throws otherwise. For server actions. */
export async function requirePvp(): Promise<User> {
  const user = await getCurrentDbUser();
  if (!(await isPvp(user.email))) throw new Error("Only a PVP can do that.");
  return user;
}

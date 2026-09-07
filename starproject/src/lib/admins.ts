import { cache } from "react";

import { prisma } from "@/lib/db";

// Global admin allowlist for destructive operations (delete task/project/subteam).
// This is NOT per-project access control — everyone still views and edits
// everything; this only gates dangerous, hard-to-undo actions.
//
// The built-in seed list below is admin by default. Both seed and runtime-added
// admins can be removed from the UI (Workspace setup → Admins): runtime admins
// live in the AdminEmail table; a removed seed is suppressed by a RemovedSeedAdmin
// tombstone (it would otherwise re-appear from this code list every request).
// Emails match the identity in X-Auth-Email (@berkeley.edu) / DEV_AUTH_EMAIL,
// compared case-insensitively.
export const SEED_ADMIN_EMAILS = [
  "aidanrickert@berkeley.edu",
  "tchang27@berkeley.edu",
  "aahilsyed72@berkeley.edu",
  "manank_doshi@berkeley.edu",
  "theo.parker@berkeley.edu",
  "24mhaggag@berkeley.edu",
  "rtaneja@berkeley.edu",
  "fohou@berkeley.edu",
  "carlosbautista@berkeley.edu",
  "inez9@berkeley.edu",
  "hudson@berkeley.edu",
].map((e) => e.toLowerCase());

// Effective admins = (seed list − removed seeds) ∪ runtime-added, lowercased.
// Memoized per request so the many isAdmin() checks in one render/action share a
// single pair of DB reads.
const getAdminEmails = cache(async (): Promise<Set<string>> => {
  const [added, removed] = await Promise.all([
    prisma.adminEmail.findMany({ select: { email: true } }),
    prisma.removedSeedAdmin.findMany({ select: { email: true } }),
  ]);
  const removedSeeds = new Set(removed.map((r) => r.email.toLowerCase()));
  const emails = new Set(SEED_ADMIN_EMAILS.filter((e) => !removedSeeds.has(e)));
  for (const r of added) emails.add(r.email.toLowerCase());
  return emails;
});

export async function isAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  return (await getAdminEmails()).has(email.toLowerCase());
}

// For the Workspace setup UI: the effective admin emails, sorted. Every admin is
// removable (seed included); the UI and removeAdmin only block removing the last.
export async function listAdmins(): Promise<{ email: string }[]> {
  const emails = [...(await getAdminEmails())].sort((a, b) => a.localeCompare(b));
  return emails.map((email) => ({ email }));
}

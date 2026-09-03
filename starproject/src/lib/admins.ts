import { cache } from "react";

import { prisma } from "@/lib/db";

// Global admin allowlist for destructive operations (delete task/project/subteam).
// This is NOT per-project access control — everyone still views and edits
// everything; this only gates dangerous, hard-to-undo actions.
//
// The built-in seed list below is always admin and can't be removed from the UI.
// Additional admins are added at runtime (Workspace setup → Admins) and live in the
// AdminEmail table. Emails match the identity in X-Auth-Email (@berkeley.edu) /
// DEV_AUTH_EMAIL, compared case-insensitively.
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

// Seed + runtime admins, lowercased. Memoized per request so the many isAdmin()
// checks in one render/action share a single DB read.
const getAdminEmails = cache(async (): Promise<Set<string>> => {
  const rows = await prisma.adminEmail.findMany({ select: { email: true } });
  return new Set([...SEED_ADMIN_EMAILS, ...rows.map((r) => r.email.toLowerCase())]);
});

export async function isAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  return (await getAdminEmails()).has(email.toLowerCase());
}

// For the Workspace setup UI: every admin email with whether it can be removed (seed
// admins are fixed in code, so only runtime-added ones are removable).
export async function listAdmins(): Promise<{ email: string; removable: boolean }[]> {
  const rows = await prisma.adminEmail.findMany({
    orderBy: { email: "asc" },
    select: { email: true },
  });
  const added = rows
    .map((r) => r.email.toLowerCase())
    .filter((e) => !SEED_ADMIN_EMAILS.includes(e))
    .map((email) => ({ email, removable: true }));
  return [
    ...SEED_ADMIN_EMAILS.map((email) => ({ email, removable: false })),
    ...added,
  ];
}

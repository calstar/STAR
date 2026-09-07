"use server";

import { revalidatePath } from "next/cache";

import { isAdmin, listAdmins, SEED_ADMIN_EMAILS } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only an existing admin may change the admin list.
async function requireAdmin() {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email))) throw new Error("Forbidden: admins only");
}

export async function addAdmin(email: string) {
  await requireAdmin();
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new Error("Enter a valid email");
  // Re-adding a previously-removed seed admin just clears its tombstone; any
  // other email becomes a runtime admin in the AdminEmail table.
  await prisma.removedSeedAdmin.deleteMany({ where: { email: clean } });
  if (!SEED_ADMIN_EMAILS.includes(clean)) {
    await prisma.adminEmail.upsert({
      where: { email: clean },
      create: { email: clean },
      update: {},
    });
  }
  revalidatePath("/", "layout"); // admin gating shows/hides UI app-wide
}

export async function removeAdmin(email: string) {
  await requireAdmin();
  const clean = email.trim().toLowerCase();
  // Never remove the last remaining admin — it would lock everyone out of the
  // destructive actions and of this page. The UI disables the button too.
  const current = await listAdmins();
  if (current.length <= 1 && current.some((a) => a.email === clean)) {
    throw new Error("Can't remove the last admin");
  }
  // Runtime admins live in AdminEmail; a seed admin (hardcoded in admins.ts) is
  // suppressed with a RemovedSeedAdmin tombstone so it doesn't re-appear.
  await prisma.adminEmail.deleteMany({ where: { email: clean } });
  if (SEED_ADMIN_EMAILS.includes(clean)) {
    await prisma.removedSeedAdmin.upsert({
      where: { email: clean },
      create: { email: clean },
      update: {},
    });
  }
  revalidatePath("/", "layout");
}

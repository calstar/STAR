"use server";

import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
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
  await prisma.adminEmail.upsert({
    where: { email: clean },
    create: { email: clean },
    update: {},
  });
  revalidatePath("/", "layout"); // admin gating shows/hides UI app-wide
}

export async function removeAdmin(email: string) {
  await requireAdmin();
  await prisma.adminEmail.deleteMany({ where: { email: email.trim().toLowerCase() } });
  revalidatePath("/", "layout");
}

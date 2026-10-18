"use server";

import { revalidatePath } from "next/cache";

import { EMAIL_RE } from "@/lib/email-roster";
import { prisma } from "@/lib/db";
import { listPvps, requirePvp, SEED_PVP_EMAILS } from "@/lib/pvp";

// Only an existing PVP may change the PVP list. Same rules as the admin list
// (src/lib/actions/admins.ts): re-adding a removed seed clears its tombstone,
// and the last PVP can't be removed, or nobody could approve a purchase again.

export async function addPvp(email: string) {
  await requirePvp();
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new Error("Enter a valid email");
  await prisma.removedSeedPvp.deleteMany({ where: { email: clean } });
  if (!SEED_PVP_EMAILS.includes(clean)) {
    await prisma.pvpEmail.upsert({ where: { email: clean }, create: { email: clean }, update: {} });
  }
  revalidatePath("/", "layout");
}

export async function removePvp(email: string) {
  await requirePvp();
  const clean = email.trim().toLowerCase();
  const current = await listPvps();
  if (current.length <= 1 && current.some((p) => p.email === clean)) {
    throw new Error("Can't remove the last PVP");
  }
  await prisma.pvpEmail.deleteMany({ where: { email: clean } });
  if (SEED_PVP_EMAILS.includes(clean)) {
    await prisma.removedSeedPvp.upsert({ where: { email: clean }, create: { email: clean }, update: {} });
  }
  revalidatePath("/", "layout");
}

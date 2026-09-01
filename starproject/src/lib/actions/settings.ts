"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getCurrentDbUser } from "@/lib/user";

export async function setTheme(theme: "light" | "dark") {
  const user = await getCurrentDbUser();
  await prisma.userSettings.upsert({
    where: { userId: user.id },
    create: { userId: user.id, theme },
    update: { theme },
  });
  revalidatePath("/", "layout");
}

// The chosen name is stored on User.displayName (not User.name, which the auth
// header clobbers every request). Empty clears the override → back to "First L.".
export async function setDisplayName(name: string) {
  const user = await getCurrentDbUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { displayName: name.trim().slice(0, 60) || null },
  });
  revalidatePath("/", "layout"); // reflect the new name everywhere it's shown
}

export type EmailPref = "emailAssignments" | "emailDueSoon" | "emailOverdue";

export async function setEmailPref(field: EmailPref, value: boolean) {
  const user = await getCurrentDbUser();
  await getSettings(user.id); // ensure the row exists
  const data: Prisma.UserSettingsUpdateInput = {};
  if (field === "emailAssignments") data.emailAssignments = value;
  else if (field === "emailDueSoon") data.emailDueSoon = value;
  else data.emailOverdue = value;
  await prisma.userSettings.update({ where: { userId: user.id }, data });
  revalidatePath("/settings");
}

export async function toggleDigestProject(projectId: string) {
  const user = await getCurrentDbUser();
  const existing = await prisma.digestSubscription.findFirst({
    where: { userId: user.id, projectId },
  });
  if (existing)
    await prisma.digestSubscription.delete({ where: { id: existing.id } });
  else
    await prisma.digestSubscription.create({
      data: { userId: user.id, projectId },
    });
  revalidatePath("/settings");
}

export async function toggleDigestSubteam(subteamId: string) {
  const user = await getCurrentDbUser();
  const existing = await prisma.digestSubscription.findFirst({
    where: { userId: user.id, subteamId },
  });
  if (existing)
    await prisma.digestSubscription.delete({ where: { id: existing.id } });
  else
    await prisma.digestSubscription.create({
      data: { userId: user.id, subteamId },
    });
  revalidatePath("/settings");
}

export async function setDigestKind(kind: string, on: boolean) {
  const user = await getCurrentDbUser();
  const s = await getSettings(user.id);
  const set = new Set(s.digestKinds);
  if (on) set.add(kind);
  else set.delete(kind);
  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { digestKinds: Array.from(set) },
  });
  revalidatePath("/settings");
}

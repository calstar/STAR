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

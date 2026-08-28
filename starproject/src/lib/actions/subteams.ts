"use server";

import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";
import { subteamCreateSchema } from "@/lib/validation";

export async function createSubteam(formData: FormData) {
  await getCurrentDbUser();
  const data = subteamCreateSchema.parse({
    name: formData.get("name"),
    color: formData.get("color"),
  });
  await prisma.subteam.create({ data: { name: data.name, color: data.color } });
  revalidatePath("/subteams");
  revalidatePath("/tasks");
}

export async function deleteSubteam(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!isAdmin(user.email))
    throw new Error("Only admins can delete subteams.");
  const id = String(formData.get("id"));
  // Optional relation → tasks' subteamId is set null (they aren't deleted).
  await prisma.subteam.delete({ where: { id } });
  revalidatePath("/subteams");
  revalidatePath("/tasks");
}

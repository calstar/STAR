"use server";

import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";
import { subteamCreateSchema } from "@/lib/validation";

/** The form action: same as createSubteamReturningId, typed void for `<form action>`. */
export async function createSubteam(formData: FormData): Promise<void> {
  await createSubteamReturningId(formData);
}

export async function createSubteamReturningId(formData: FormData): Promise<{ id: string }> {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
    throw new Error("Only admins can create subteams.");
  const data = subteamCreateSchema.parse({
    name: formData.get("name"),
    color: formData.get("color"),
  });
  const created = await prisma.subteam.create({ data: { name: data.name, color: data.color } });
  revalidatePath("/subteams");
  revalidatePath("/tasks");
  // The MCP tool reads the new subteam back by id.
  return { id: created.id };
}

export async function updateSubteam(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
    throw new Error("Only admins can edit subteams.");
  const id = String(formData.get("id"));
  const data = subteamCreateSchema.parse({
    name: formData.get("name"),
    color: formData.get("color"),
  });
  await prisma.subteam.update({
    where: { id },
    data: { name: data.name, color: data.color },
  });
  revalidatePath("/workspace");
  revalidatePath("/subteams");
  revalidatePath(`/subteams/${id}`);
  revalidatePath("/tasks");
}

export async function deleteSubteam(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
    throw new Error("Only admins can delete subteams.");
  const id = String(formData.get("id"));
  // Optional relation → tasks' subteamId is set null (they aren't deleted).
  await prisma.subteam.delete({ where: { id } });
  revalidatePath("/subteams");
  revalidatePath("/tasks");
}

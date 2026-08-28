"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";
import { projectCreateSchema } from "@/lib/validation";

export async function createProject(formData: FormData) {
  const user = await getCurrentDbUser();
  const data = projectCreateSchema.parse({
    name: formData.get("name"),
    description: formData.get("description"),
    color: formData.get("color"),
  });
  const project = await prisma.project.create({
    data: {
      name: data.name,
      description: data.description,
      color: data.color,
      createdById: user.id,
    },
  });
  revalidatePath("/");
  redirect(`/projects/${project.id}`);
}

export async function archiveProject(formData: FormData) {
  await getCurrentDbUser();
  const id = String(formData.get("id"));
  const archived = formData.get("archived") === "true";
  await prisma.project.update({ where: { id }, data: { archived } });
  revalidatePath("/");
}

export async function deleteProject(formData: FormData) {
  await getCurrentDbUser();
  const id = String(formData.get("id"));
  await prisma.project.delete({ where: { id } }); // cascades to its tasks
  revalidatePath("/");
  redirect("/");
}

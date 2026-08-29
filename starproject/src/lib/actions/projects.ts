"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";
import { projectCreateSchema } from "@/lib/validation";

export async function createProject(formData: FormData) {
  const user = await getCurrentDbUser();
  const data = projectCreateSchema.parse({
    name: formData.get("name"),
    description: formData.get("description"),
    color: formData.get("color"),
    parentId: formData.get("parentId"),
  });
  if (data.parentId) {
    const parent = await prisma.project.findUnique({
      where: { id: data.parentId },
      select: { parentId: true },
    });
    if (!parent) throw new Error("Parent project not found");
    // Enforce a single level of nesting.
    if (parent.parentId)
      throw new Error("Subprojects can't have their own subprojects");
  }
  const project = await prisma.project.create({
    data: {
      name: data.name,
      description: data.description,
      color: data.color,
      parentId: data.parentId,
      createdById: user.id,
    },
  });
  revalidatePath("/projects");
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
  const user = await getCurrentDbUser();
  if (!isAdmin(user.email))
    throw new Error("Only admins can delete projects.");
  const id = String(formData.get("id"));
  await prisma.project.delete({ where: { id } }); // cascades to its tasks
  revalidatePath("/projects");
  redirect("/projects");
}

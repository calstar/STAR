"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { seedSubteamPhases } from "@/lib/program-seed";
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

export async function updateProject(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
    throw new Error("Only admins can edit projects.");
  const id = String(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Project name is required.");
  const descriptionRaw = String(formData.get("description") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim() || null;

  // Moving a project under another (or back to the top) — only when the form
  // carries the field, so older callers keep editing name/color alone.
  let parentPatch: { parentId: string | null; featured?: boolean } | undefined;
  if (formData.has("parentId")) {
    const parentId = String(formData.get("parentId") ?? "") || null;
    const current = await prisma.project.findUniqueOrThrow({
      where: { id },
      select: { parentId: true, _count: { select: { children: true } } },
    });
    if (parentId !== current.parentId) {
      if (parentId) {
        if (parentId === id) throw new Error("A project can't be its own parent.");
        const parent = await prisma.project.findUnique({
          where: { id: parentId },
          select: { parentId: true },
        });
        if (!parent) throw new Error("Parent project not found.");
        // Same single level of nesting createProject enforces.
        if (parent.parentId)
          throw new Error("Subprojects can't have their own subprojects.");
        if (current._count.children > 0)
          throw new Error(
            "This project has subprojects, so it can't become one. Move its subprojects first.",
          );
        // It now shows on its parent's homepage card, not a card of its own.
        parentPatch = { parentId, featured: false };
      } else {
        parentPatch = { parentId: null };
      }
    }
  }

  await prisma.project.update({
    where: { id },
    data: {
      name,
      description: descriptionRaw === "" ? null : descriptionRaw,
      color,
      ...parentPatch,
    },
  });
  if (parentPatch?.parentId) await seedSubteamPhases(id);
  revalidatePath("/", "layout"); // sidebar + homepage cards follow the hierarchy
  revalidatePath("/workspace");
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
}

export async function deleteProject(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
    throw new Error("Only admins can delete projects.");
  const id = String(formData.get("id"));
  await prisma.project.delete({ where: { id } }); // cascades to its tasks
  revalidatePath("/workspace");
  revalidatePath("/projects");
}

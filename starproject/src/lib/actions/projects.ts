"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { seedSubteamPhases } from "@/lib/program-seed";
import { descendants, moveProblem } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
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
  // Projects nest to any depth (LE4 › Engine › Spark igniter); the parent
  // only has to exist.
  if (data.parentId) {
    const parent = await prisma.project.findUnique({
      where: { id: data.parentId },
      select: { id: true },
    });
    if (!parent) throw new Error("Parent project not found");
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
    const tree = await getProjectTree();
    const current = tree.byId.get(id);
    if (!current) throw new Error("Project not found.");
    if (parentId !== current.parentId) {
      // Any depth is fine; a loop is not (under itself or its own subproject).
      const problem = moveProblem(tree, id, parentId);
      if (problem) throw new Error(problem);
      // A subproject shows on its top-level project's homepage card, never a
      // card of its own.
      parentPatch = parentId ? { parentId, featured: false } : { parentId: null };
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
  if (parentPatch?.parentId) {
    // The moved project brings its whole branch along.
    const tree = await getProjectTree();
    for (const pid of [id, ...descendants(tree, id).map((d) => d.id)]) {
      await seedSubteamPhases(pid);
    }
  }
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

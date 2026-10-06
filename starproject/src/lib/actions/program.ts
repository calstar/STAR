"use server";

import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { clampPhase, phasesOf } from "@/lib/program";
import { seedSubteamPhases } from "@/lib/program-seed";
import { getCurrentDbUser } from "@/lib/user";
import { isValidDateInput } from "@/lib/validation";

// Like task edits, moving a subteam's phase or adding a deadline is open to
// everyone. Choosing which project the homepage tracks, and its phase list,
// changes what the whole team sees, so those are admin-only.
async function requireAdmin() {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email))) throw new Error("Forbidden: admins only");
}

export async function setFeatured(projectId: string, featured: boolean) {
  await requireAdmin();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { parentId: true, children: { select: { id: true } } },
  });
  if (!project) throw new Error("Project not found");
  if (project.parentId) throw new Error("Track the parent project; its subprojects come with it");
  // A newly tracked project goes to the bottom, so it never pushes the main
  // program off the top of the page.
  const last = await prisma.project.aggregate({
    where: { featured: true },
    _max: { trackOrder: true },
  });
  await prisma.project.update({
    where: { id: projectId },
    data: featured
      ? { featured, trackOrder: (last._max.trackOrder ?? 0) + 1 }
      : { featured },
  });
  if (featured) {
    for (const id of [projectId, ...project.children.map((c) => c.id)]) {
      await seedSubteamPhases(id);
    }
  }
  revalidatePath("/");
}

export async function setPhases(projectId: string, phases: string[]) {
  await requireAdmin();
  const clean = phases.map((p) => p.trim()).filter(Boolean);
  if (clean.length > 12) throw new Error("At most 12 phases");
  if (clean.some((p) => p.length > 40)) throw new Error("Phase names are at most 40 characters");
  await prisma.project.update({ where: { id: projectId }, data: { phases: clean } });
  revalidatePath("/");
}

export async function setSubteamPhase(projectId: string, subteamId: string, phase: number) {
  await getCurrentDbUser();
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { phases: true },
  });
  const p = clampPhase(Math.trunc(phase), phasesOf(project).length);
  await prisma.subteamPhase.upsert({
    where: { projectId_subteamId: { projectId, subteamId } },
    create: { projectId, subteamId, phase: p },
    update: { phase: p },
  });
  revalidatePath("/");
}

export async function untrackSubteam(projectId: string, subteamId: string) {
  await requireAdmin();
  await prisma.subteamPhase.deleteMany({ where: { projectId, subteamId } });
  revalidatePath("/");
}

export async function addMilestone(
  projectId: string,
  input: { title: string; dueDate: string; subteamId: string | null },
) {
  await getCurrentDbUser();
  const title = input.title.trim();
  if (!title) throw new Error("Give the deadline a name");
  if (title.length > 120) throw new Error("Keep the name under 120 characters");
  if (!input.dueDate || !isValidDateInput(input.dueDate)) throw new Error("Pick a valid date");
  await prisma.milestone.create({
    data: {
      projectId,
      subteamId: input.subteamId || null,
      title,
      dueDate: new Date(input.dueDate),
    },
  });
  revalidatePath("/");
}

export async function setMilestoneDone(id: string, done: boolean) {
  await getCurrentDbUser();
  await prisma.milestone.update({ where: { id }, data: { done } });
  revalidatePath("/");
}

export async function deleteMilestone(id: string) {
  await getCurrentDbUser();
  await prisma.milestone.delete({ where: { id } });
  revalidatePath("/");
}

/** Re-number the homepage cards: `projectIds` are the tracked top-level
 * projects, top to bottom. Subprojects ride on their parent's card. */
export async function setCardOrder(projectIds: string[]) {
  await requireAdmin();
  await prisma.$transaction(
    projectIds.map((id, i) => prisma.project.update({ where: { id }, data: { trackOrder: i } })),
  );
  revalidatePath("/");
}

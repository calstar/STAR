"use server";

import { revalidatePath } from "next/cache";

import { recordActivity, userLabel } from "@/lib/activity";
import { prisma } from "@/lib/db";
import {
  type ManufacturingField,
  isManufacturingField,
  parseManufacturingValue,
} from "@/lib/manufacturing";
import { getCurrentDbUser } from "@/lib/user";

// A task becomes a manufacturing task when it gets a TaskManufacturing row and
// stops being one when the row is removed. Every change is logged to History
// like any other task edit.

const userSelect = { select: { name: true, email: true, displayName: true } } as const;

async function taskFor(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, projectId: true },
  });
  if (!task) throw new Error("Task not found");
  return task;
}

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");
}

/** Mark a task as a manufacturing part (an empty set of details to fill in). */
export async function addManufacturing(taskId: string) {
  const user = await getCurrentDbUser();
  const task = await taskFor(taskId);
  const existing = await prisma.taskManufacturing.findUnique({ where: { taskId } });
  if (existing) return;
  await prisma.taskManufacturing.create({ data: { taskId } });
  await recordActivity({
    actorId: user.id,
    taskId: task.id,
    projectId: task.projectId,
    taskTitle: task.title,
    kind: "updated",
    field: "manufacturing",
    from: "no",
    to: "yes",
  });
  revalidate(task.projectId);
}

/** Drop a task's manufacturing details (and with them its manufacturing status).
 * Takes FormData so it can sit behind ConfirmButton. */
export async function removeManufacturing(formData: FormData) {
  const user = await getCurrentDbUser();
  const task = await taskFor(String(formData.get("id")));
  const { count } = await prisma.taskManufacturing.deleteMany({ where: { taskId: task.id } });
  if (count === 0) return;
  await recordActivity({
    actorId: user.id,
    taskId: task.id,
    projectId: task.projectId,
    taskTitle: task.title,
    kind: "updated",
    field: "manufacturing",
    from: "yes",
    to: "no",
  });
  revalidate(task.projectId);
}

/** Save one manufacturing field; blank clears it. Returns an error message for
 * a value the user should fix, rather than throwing, so the form can show it. */
export async function updateManufacturingField(
  taskId: string,
  field: string,
  raw: string,
): Promise<{ error?: string }> {
  const user = await getCurrentDbUser();
  if (!isManufacturingField(field)) throw new Error(`Unknown field: ${field}`);
  let value: string | number | null;
  try {
    value = parseManufacturingValue(field, raw);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const task = await taskFor(taskId);
  const old = await prisma.taskManufacturing.findUnique({
    where: { taskId },
    include: { designRe: userSelect, mfgRe: userSelect },
  });
  if (!old) return { error: "This task has no manufacturing details." };

  if ((field === "designReId" || field === "mfgReId") && value !== null) {
    const exists = await prisma.user.count({ where: { id: value as string } });
    if (!exists) return { error: "That person isn't on the team." };
  }
  if (old[field] === value) return {};

  const updated = await prisma.taskManufacturing.update({
    where: { taskId },
    data: { [field]: value },
    include: { designRe: userSelect, mfgRe: userSelect },
  });

  const shown = (row: typeof old, f: ManufacturingField): string => {
    if (f === "designReId") return row.designRe ? userLabel(row.designRe) : "—";
    if (f === "mfgReId") return row.mfgRe ? userLabel(row.mfgRe) : "—";
    const v = row[f];
    return v === null ? "—" : String(v);
  };
  await recordActivity({
    actorId: user.id,
    taskId: task.id,
    projectId: task.projectId,
    taskTitle: task.title,
    kind: "updated",
    field,
    from: shown(old, field),
    to: shown(updated, field),
  });
  revalidate(task.projectId);
  return {};
}

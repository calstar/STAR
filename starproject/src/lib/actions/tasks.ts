"use server";

import { Prisma, type TaskStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";
import {
  TaskPriorityEnum,
  TaskStatusEnum,
  taskCreateSchema,
} from "@/lib/validation";

export async function createTask(formData: FormData) {
  const user = await getCurrentDbUser();
  const data = taskCreateSchema.parse({
    projectId: formData.get("projectId"),
    title: formData.get("title"),
    description: formData.get("description"),
    priority: formData.get("priority"),
    assigneeId: formData.get("assigneeId"),
    startDate: formData.get("startDate"),
    dueDate: formData.get("dueDate"),
  });
  await prisma.task.create({
    data: {
      projectId: data.projectId,
      title: data.title,
      description: data.description,
      priority: data.priority,
      assigneeId: data.assigneeId,
      startDate: data.startDate,
      dueDate: data.dueDate,
      createdById: user.id,
    },
  });
  revalidatePath(`/projects/${data.projectId}`);
}

/**
 * Partial update: only fields actually present in the FormData are touched, so
 * each inline control in a TaskRow can submit just its own field without
 * clobbering the others. An empty value clears the (nullable) field.
 */
export async function updateTask(formData: FormData) {
  await getCurrentDbUser();
  const id = String(formData.get("id"));
  if (!id) throw new Error("updateTask: missing task id");

  const data: Prisma.TaskUpdateInput = {};

  if (formData.has("title")) {
    data.title = z.string().trim().min(1).max(300).parse(formData.get("title"));
  }
  if (formData.has("description")) {
    const v = String(formData.get("description") ?? "").trim();
    data.description = v === "" ? null : v;
  }
  if (formData.has("status")) {
    data.status = TaskStatusEnum.parse(formData.get("status"));
  }
  if (formData.has("priority")) {
    const v = formData.get("priority");
    data.priority = v === "" || v == null ? null : TaskPriorityEnum.parse(v);
  }
  if (formData.has("assigneeId")) {
    const v = formData.get("assigneeId");
    data.assignee = v ? { connect: { id: String(v) } } : { disconnect: true };
  }
  if (formData.has("dueDate")) {
    const v = String(formData.get("dueDate") ?? "");
    data.dueDate = v === "" ? null : new Date(v);
  }
  if (formData.has("startDate")) {
    const v = String(formData.get("startDate") ?? "");
    data.startDate = v === "" ? null : new Date(v);
  }

  const task = await prisma.task.update({ where: { id }, data });
  revalidatePath(`/projects/${task.projectId}`);
}

export async function deleteTask(formData: FormData) {
  await getCurrentDbUser();
  const id = String(formData.get("id"));
  const task = await prisma.task.delete({ where: { id } });
  revalidatePath(`/projects/${task.projectId}`);
}

/**
 * Kanban move: set a task's column (status) and its fractional position
 * (boardOrder). Called with typed args from the board client component.
 */
export async function moveTask(
  id: string,
  status: TaskStatus,
  boardOrder: number,
) {
  await getCurrentDbUser();
  const parsed = z
    .object({
      id: z.string().min(1),
      status: TaskStatusEnum,
      boardOrder: z.number().finite(),
    })
    .parse({ id, status, boardOrder });

  const task = await prisma.task.update({
    where: { id: parsed.id },
    data: { status: parsed.status, boardOrder: parsed.boardOrder },
  });
  revalidatePath(`/projects/${task.projectId}`);
}

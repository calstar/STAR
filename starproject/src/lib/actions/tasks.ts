"use server";

import { Prisma, type TaskStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import {
  dateLabel,
  priorityLabel,
  recordActivity,
  subteamLabel,
  userLabel,
} from "@/lib/activity";
import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { notifyAssignment } from "@/lib/notifications";
import { STATUS_LABEL } from "@/lib/tasks";
import { getCurrentDbUser } from "@/lib/user";
import {
  TaskPriorityEnum,
  TaskStatusEnum,
  taskCreateSchema,
} from "@/lib/validation";

// What updateTask / moveTask re-read so activities can render human values.
const withNames = {
  assignee: { select: { name: true, email: true } },
  subteam: { select: { name: true } },
} as const;

export async function createTask(formData: FormData) {
  const user = await getCurrentDbUser();
  const data = taskCreateSchema.parse({
    projectId: formData.get("projectId"),
    title: formData.get("title"),
    description: formData.get("description"),
    priority: formData.get("priority"),
    assigneeId: formData.get("assigneeId"),
    subteamId: formData.get("subteamId"),
    startDate: formData.get("startDate"),
    dueDate: formData.get("dueDate"),
  });
  const created = await prisma.task.create({
    data: {
      projectId: data.projectId,
      title: data.title,
      description: data.description,
      priority: data.priority,
      assigneeId: data.assigneeId,
      subteamId: data.subteamId,
      startDate: data.startDate,
      dueDate: data.dueDate,
      createdById: user.id,
    },
  });

  await recordActivity({
    actorId: user.id,
    taskId: created.id,
    projectId: created.projectId,
    taskTitle: created.title,
    kind: "created",
  });

  revalidatePath(`/projects/${data.projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");

  if (data.assigneeId) {
    const assigneeId = data.assigneeId;
    after(() =>
      notifyAssignment({ taskId: created.id, assigneeId, actorId: user.id }),
    );
  }
}

/**
 * Partial update: only fields actually present in the FormData are touched, so
 * each inline control in a TaskRow can submit just its own field without
 * clobbering the others. An empty value clears the (nullable) field. Every
 * changed field is logged to the Activity feed with its before/after value.
 */
export async function updateTask(formData: FormData) {
  const user = await getCurrentDbUser();
  const id = String(formData.get("id"));
  if (!id) throw new Error("updateTask: missing task id");

  const old = await prisma.task.findUnique({
    where: { id },
    include: withNames,
  });
  if (!old) throw new Error("updateTask: task not found");

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
  if (formData.has("subteamId")) {
    const v = formData.get("subteamId");
    data.subteam = v ? { connect: { id: String(v) } } : { disconnect: true };
  }
  if (formData.has("dueDate")) {
    const v = String(formData.get("dueDate") ?? "");
    data.dueDate = v === "" ? null : new Date(v);
  }
  if (formData.has("startDate")) {
    const v = String(formData.get("startDate") ?? "");
    data.startDate = v === "" ? null : new Date(v);
  }

  const task = await prisma.task.update({
    where: { id },
    data,
    include: withNames,
  });
  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/tasks");

  // Log each changed field (skip description — long/noisy).
  const log = (field: string, from: string, to: string) =>
    recordActivity({
      actorId: user.id,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      kind: "updated",
      field,
      from,
      to,
    });

  if (formData.has("title") && old.title !== task.title)
    await log("title", old.title, task.title);
  if (formData.has("status") && old.status !== task.status)
    await log("status", STATUS_LABEL[old.status], STATUS_LABEL[task.status]);
  if (formData.has("priority") && old.priority !== task.priority)
    await log("priority", priorityLabel(old.priority), priorityLabel(task.priority));
  if (
    formData.has("dueDate") &&
    old.dueDate?.getTime() !== task.dueDate?.getTime()
  )
    await log("due", dateLabel(old.dueDate), dateLabel(task.dueDate));
  if (formData.has("assigneeId") && old.assigneeId !== task.assigneeId)
    await log("assignee", userLabel(old.assignee), userLabel(task.assignee));
  if (formData.has("subteamId") && old.subteamId !== task.subteamId)
    await log(
      "subteam",
      subteamLabel(old.subteam?.name),
      subteamLabel(task.subteam?.name),
    );

  revalidatePath("/activity");

  if (task.assigneeId && task.assigneeId !== old.assigneeId) {
    const newAssigneeId = task.assigneeId;
    after(() =>
      notifyAssignment({
        taskId: task.id,
        assigneeId: newAssigneeId,
        actorId: user.id,
      }),
    );
  }
}

export async function deleteTask(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!isAdmin(user.email))
    throw new Error("Only admins can delete tasks.");
  const id = String(formData.get("id"));
  const task = await prisma.task.delete({ where: { id } });

  await recordActivity({
    actorId: user.id,
    taskId: null, // task is gone; the log keeps the title snapshot
    projectId: task.projectId,
    taskTitle: task.title,
    kind: "deleted",
  });

  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");
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
  const user = await getCurrentDbUser();
  const parsed = z
    .object({
      id: z.string().min(1),
      status: TaskStatusEnum,
      boardOrder: z.number().finite(),
    })
    .parse({ id, status, boardOrder });

  const old = await prisma.task.findUnique({
    where: { id: parsed.id },
    select: { status: true },
  });

  const task = await prisma.task.update({
    where: { id: parsed.id },
    data: { status: parsed.status, boardOrder: parsed.boardOrder },
  });
  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/tasks");

  if (old && old.status !== task.status) {
    await recordActivity({
      actorId: user.id,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      kind: "updated",
      field: "status",
      from: STATUS_LABEL[old.status],
      to: STATUS_LABEL[task.status],
    });
    revalidatePath("/activity");
  }
}

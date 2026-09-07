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
import { STATUS_LABEL, archivedForStatusChange } from "@/lib/tasks";
import { getCurrentDbUser } from "@/lib/user";
import {
  TaskPriorityEnum,
  TaskStatusEnum,
  csvToIds,
  isValidDateInput,
  taskCreateSchema,
} from "@/lib/validation";

// What updateTask / moveTask re-read so activities can render human values.
const withNames = {
  assignees: { select: { id: true, name: true, email: true, displayName: true } },
  subteam: { select: { name: true } },
} as const;

export async function createTask(formData: FormData) {
  const user = await getCurrentDbUser();
  const data = taskCreateSchema.parse({
    projectId: formData.get("projectId"),
    title: formData.get("title"),
    description: formData.get("description"),
    priority: formData.get("priority"),
    assigneeIds: formData.get("assigneeIds"),
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
      assignees: data.assigneeIds.length
        ? { connect: data.assigneeIds.map((id) => ({ id })) }
        : undefined,
      subteamId: data.subteamId,
      startDate: data.startDate,
      dueDate: data.dueDate,
      createdById: user.id,
    },
    include: withNames,
  });

  await recordActivity({
    actorId: user.id,
    taskId: created.id,
    projectId: created.projectId,
    taskTitle: created.title,
    kind: "created",
  });
  // Log any initial assignees so history reads "created" then "assigned …".
  for (const a of created.assignees)
    await recordActivity({
      actorId: user.id,
      taskId: created.id,
      projectId: created.projectId,
      taskTitle: created.title,
      kind: "assigned",
      to: userLabel(a),
    });

  revalidatePath(`/projects/${data.projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");

  for (const assigneeId of data.assigneeIds) {
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
/** Persist a start/due change from dragging or resizing a Gantt bar. Dates are
 * YYYY-MM-DD strings. Reuses updateTask so the change is logged like any edit. */
export async function setTaskDates(taskId: string, start: string, end: string) {
  const fd = new FormData();
  fd.set("id", taskId);
  fd.set("startDate", start);
  fd.set("dueDate", end);
  await updateTask(fd);
}

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
  if (formData.has("blockedNote")) {
    const v = String(formData.get("blockedNote") ?? "").trim();
    data.blockedNote = v === "" ? null : v;
  }
  if (formData.has("status")) {
    const status = TaskStatusEnum.parse(formData.get("status"));
    data.status = status;
    Object.assign(data, archivedForStatusChange(old.status, status));
  }
  if (formData.has("priority")) {
    const v = formData.get("priority");
    data.priority = v === "" || v == null ? null : TaskPriorityEnum.parse(v);
  }
  if (formData.has("assigneeIds")) {
    const ids = csvToIds(formData.get("assigneeIds"));
    data.assignees = { set: ids.map((id) => ({ id })) };
  }
  if (formData.has("subteamId")) {
    const v = formData.get("subteamId");
    data.subteam = v ? { connect: { id: String(v) } } : { disconnect: true };
  }
  if (formData.has("dueDate")) {
    const v = String(formData.get("dueDate") ?? "");
    if (!isValidDateInput(v)) throw new Error("Enter a valid due date with a 4-digit year.");
    data.dueDate = v === "" ? null : new Date(v);
  }
  if (formData.has("startDate")) {
    const v = String(formData.get("startDate") ?? "");
    if (!isValidDateInput(v)) throw new Error("Enter a valid start date with a 4-digit year.");
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
  // Assignee changes are logged per person, one row each.
  const logAssignee = (kind: "assigned" | "unassigned", who: string) =>
    recordActivity({
      actorId: user.id,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      kind,
      to: who,
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
  const oldAssigneeIds = old.assignees.map((a) => a.id);
  const newAssigneeIds = task.assignees.map((a) => a.id);
  const addedAssignees = task.assignees.filter(
    (a) => !oldAssigneeIds.includes(a.id),
  );
  const removedAssignees = old.assignees.filter(
    (a) => !newAssigneeIds.includes(a.id),
  );
  if (formData.has("assigneeIds")) {
    for (const a of addedAssignees) await logAssignee("assigned", userLabel(a));
    for (const a of removedAssignees)
      await logAssignee("unassigned", userLabel(a));
  }
  if (formData.has("subteamId") && old.subteamId !== task.subteamId)
    await log(
      "subteam",
      subteamLabel(old.subteam?.name),
      subteamLabel(task.subteam?.name),
    );

  revalidatePath("/activity");

  // Notify only the newly-added assignees (not those who were already on it).
  for (const a of addedAssignees) {
    after(() =>
      notifyAssignment({ taskId: task.id, assigneeId: a.id, actorId: user.id }),
    );
  }
}

// Archive / unarchive a task: it stays in the DB (fully recoverable) but drops
// out of the active board and lists into the Archived section. Reversible and
// low-risk, so any signed-in user may do it; the UI only offers it once done.
export async function archiveTask(taskId: string, archived: boolean) {
  await getCurrentDbUser();
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { archived },
    select: { projectId: true },
  });
  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/");
}

export async function deleteTask(formData: FormData) {
  const user = await getCurrentDbUser();
  if (!(await isAdmin(user.email)))
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
    data: {
      status: parsed.status,
      boardOrder: parsed.boardOrder,
      // Auto-archive on completion; dragging back out of Done restores it.
      ...(old ? archivedForStatusChange(old.status, parsed.status) : {}),
    },
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

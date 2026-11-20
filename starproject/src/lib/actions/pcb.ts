"use server";

import type { PcbStageStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { dateLabel, recordActivity, userLabel, usersLabel } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { notifyAssignment } from "@/lib/notifications";
import {
  PCB_STAGES,
  PCB_STATE_LABEL,
  type PcbStageKey,
  type PcbStageState,
  derivedDueDate,
  isPcbStage,
  parseAltiumUrl,
  stageAssignees,
  stageField,
} from "@/lib/pcb";
import { getCurrentDbUser } from "@/lib/user";
import { isValidDateInput } from "@/lib/validation";

// A task becomes a PCB task when it gets a TaskPcb row (with all six stages)
// and stops being one when the row is removed. The stages own two of the
// task's fields:
//   - assignees: every stage-assignee edit sets the task's assignees to
//     everyone on any stage (logged and notified like any assignment);
//   - due date: every stage date or skip edit sets it to the last dated stage
//     that isn't skipped, while there is one.
// Nothing cascades between stages, and the task's status stays manual.

const person = { select: { id: true, name: true, email: true, displayName: true } } as const;

type Actor = { id: string };

async function taskFor(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, projectId: true, dueDate: true, startDate: true },
  });
  if (!task) throw new Error("Task not found");
  return task;
}

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");
  revalidatePath("/subteams", "layout");
}

type TaskRef = Awaited<ReturnType<typeof taskFor>>;

function logger(user: Actor, task: TaskRef) {
  return (field: string, from: string, to: string) =>
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
}

/** Make a task a PCB board: all six stages, open, undated and unassigned. The
 * task's own assignees and due date are left as they are until a stage sets them. */
export async function addPcb(taskId: string) {
  const user = await getCurrentDbUser();
  const task = await taskFor(taskId);
  const existing = await prisma.taskPcb.findUnique({ where: { taskId } });
  if (existing) return;
  await prisma.taskPcb.create({
    data: { taskId, stages: { create: PCB_STAGES.map((stage) => ({ stage })) } },
  });
  await logger(user, task)("pcb", "no", "yes");
  revalidate(task.projectId);
}

/** Drop a task's PCB details and stages. Its assignees and due date stay as the
 * stages last set them. Takes FormData so it can sit behind ConfirmButton. */
export async function removePcb(formData: FormData) {
  const user = await getCurrentDbUser();
  const task = await taskFor(String(formData.get("id")));
  const { count } = await prisma.taskPcb.deleteMany({ where: { taskId: task.id } });
  if (count === 0) return;
  await logger(user, task)("pcb", "yes", "no");
  revalidate(task.projectId);
}

/** Save the Altium project link; blank clears it. */
export async function updateAltiumUrl(taskId: string, raw: string): Promise<{ error?: string }> {
  const user = await getCurrentDbUser();
  let value: string | null;
  try {
    value = parseAltiumUrl(raw);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const task = await taskFor(taskId);
  const old = await prisma.taskPcb.findUnique({ where: { taskId } });
  if (!old) return { error: "This task is not a PCB board." };
  if (old.altiumUrl === value) return {};
  await prisma.taskPcb.update({ where: { taskId }, data: { altiumUrl: value } });
  await logger(user, task)("altiumUrl", old.altiumUrl ?? "—", value ?? "—");
  revalidate(task.projectId);
  return {};
}

export type StagePatch = {
  /** YYYY-MM-DD; "" or null clears it. */
  dueDate?: string | null;
  status?: PcbStageState;
  /** Replaces the stage's assignees; [] leaves it unassigned. */
  assigneeIds?: string[];
};

/**
 * Edit one stage: any of its due date, state and assignees. Returns an error
 * message for a value the user should fix, rather than throwing, so the form
 * can show it. Then brings the task's assignees and due date in line with the
 * stages.
 */
export async function updatePcbStage(
  taskId: string,
  stage: string,
  patch: StagePatch,
): Promise<{ error?: string }> {
  const user = await getCurrentDbUser();
  if (!isPcbStage(stage)) return { error: `Unknown stage: ${stage}` };

  let due: Date | null | undefined;
  if (patch.dueDate !== undefined) {
    const v = (patch.dueDate ?? "").trim();
    if (v !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "Use a YYYY-MM-DD date." };
    if (!isValidDateInput(v)) return { error: "Enter a valid date with a 4-digit year." };
    due = v === "" ? null : new Date(v);
  }
  if (patch.status !== undefined && !["open", "done", "skipped"].includes(patch.status))
    return { error: "A stage is open, done or skipped." };
  let ids: string[] | undefined;
  if (patch.assigneeIds !== undefined) {
    ids = [...new Set(patch.assigneeIds.filter(Boolean))];
    const found = await prisma.user.count({ where: { id: { in: ids } } });
    if (found !== ids.length) return { error: "Someone picked isn't on the team." };
  }

  const task = await taskFor(taskId);
  const old = await prisma.taskPcbStage.findUnique({
    where: { taskId_stage: { taskId, stage } },
    include: { assignees: person },
  });
  if (!old) return { error: "This task is not a PCB board." };

  const updated = await prisma.taskPcbStage.update({
    where: { id: old.id },
    data: {
      ...(due !== undefined ? { dueDate: due } : {}),
      ...(patch.status !== undefined ? { status: patch.status as PcbStageStatus } : {}),
      ...(ids !== undefined ? { assignees: { set: ids.map((id) => ({ id })) } } : {}),
    },
    include: { assignees: person },
  });

  const log = logger(user, task);
  if (due !== undefined && old.dueDate?.getTime() !== updated.dueDate?.getTime())
    await log(stageField(stage, "due"), dateLabel(old.dueDate), dateLabel(updated.dueDate));
  if (patch.status !== undefined && old.status !== updated.status)
    await log(stageField(stage, "status"), PCB_STATE_LABEL[old.status], PCB_STATE_LABEL[updated.status]);
  const oldIds = old.assignees.map((a) => a.id).sort().join(",");
  const newIds = updated.assignees.map((a) => a.id).sort().join(",");
  if (ids !== undefined && oldIds !== newIds)
    await log(stageField(stage, "assignees"), usersLabel(old.assignees), usersLabel(updated.assignees));

  if (ids !== undefined) await syncAssignees(user, task);
  if (due !== undefined || patch.status !== undefined) await syncDueDate(user, task);
  revalidate(task.projectId);
  return {};
}

/**
 * Move the whole board by `days` (what dragging a PCB task's Gantt bar does):
 * its start date and every stage's due date shift together. One activity row
 * says how far.
 */
export async function shiftPcbDates(taskId: string, days: number): Promise<void> {
  const user = await getCurrentDbUser();
  if (!Number.isInteger(days) || Math.abs(days) > 3650) throw new Error("Shift by a whole number of days.");
  if (days === 0) return;
  const task = await taskFor(taskId);
  const stages = await prisma.taskPcbStage.findMany({ where: { taskId, dueDate: { not: null } } });
  if (stages.length === 0) throw new Error("This board has no stage dates to move.");

  const by = (d: Date) => new Date(d.getTime() + days * 86_400_000);
  await prisma.$transaction([
    ...stages.map((s) =>
      prisma.taskPcbStage.update({ where: { id: s.id }, data: { dueDate: by(s.dueDate as Date) } }),
    ),
    ...(task.startDate
      ? [prisma.task.update({ where: { id: taskId }, data: { startDate: by(task.startDate) } })]
      : []),
  ]);
  // "2026-11-03 – 2026-11-25" → the same span moved, so the row reads as a move.
  const span = (shift: number) => {
    const t = stages.map((s) => (s.dueDate as Date).getTime() + shift * 86_400_000);
    return `${dateLabel(new Date(Math.min(...t)))} – ${dateLabel(new Date(Math.max(...t)))}`;
  };
  await logger(user, task)("pcb.shift", span(0), span(days));
  await syncDueDate(user, task);
  revalidate(task.projectId);
}

/** Set the task's assignees to everyone on any stage; log and notify each
 * person added or taken off, as updateTask does. */
async function syncAssignees(user: Actor, task: TaskRef) {
  const [stages, current] = await Promise.all([
    prisma.taskPcbStage.findMany({ where: { taskId: task.id }, include: { assignees: person } }),
    prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: { assignees: person } }),
  ]);
  const want = stageAssignees(stages.map((s) => ({ stage: s.stage as PcbStageKey, assignees: s.assignees })));
  const wantIds = new Set(want.map((a) => a.id));
  const haveIds = new Set(current.assignees.map((a) => a.id));
  const added = want.filter((a) => !haveIds.has(a.id));
  const removed = current.assignees.filter((a) => !wantIds.has(a.id));
  if (added.length === 0 && removed.length === 0) return;

  await prisma.task.update({
    where: { id: task.id },
    data: { assignees: { set: want.map((a) => ({ id: a.id })) } },
  });
  const row = (kind: "assigned" | "unassigned", who: string) =>
    recordActivity({
      actorId: user.id,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      kind,
      to: who,
    });
  for (const a of added) await row("assigned", userLabel(a));
  for (const a of removed) await row("unassigned", userLabel(a));
  for (const a of added)
    after(() => notifyAssignment({ taskId: task.id, assigneeId: a.id, actorId: user.id }));
}

/** Set the task's due date to the last dated stage that isn't skipped. With no
 * such stage, the task keeps the due date it has. */
async function syncDueDate(user: Actor, task: TaskRef) {
  const stages = await prisma.taskPcbStage.findMany({
    where: { taskId: task.id },
    select: { status: true, dueDate: true },
  });
  const want = derivedDueDate(stages);
  if (!want) return;
  const now = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: { dueDate: true } });
  if (now.dueDate?.getTime() === want.getTime()) return;
  await prisma.task.update({ where: { id: task.id }, data: { dueDate: want } });
  await logger(user, task)("due", dateLabel(now.dueDate), dateLabel(want));
}

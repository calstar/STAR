"use server";

import { prisma } from "@/lib/db";
import { getTaskDetailData, type TaskDetailData } from "@/lib/task-detail";

/** Client entry point for the in-place task modal: fetches the same detail data
 * the (now-removed) task page used, so a task can open as an overlay anywhere
 * without a URL change. Returns null if the task isn't in the project. */
export async function loadTaskDetail(
  projectId: string,
  taskId: string,
): Promise<TaskDetailData | null> {
  return getTaskDetailData(projectId, taskId);
}

/** Open a task from just its id (for `?task=<id>` share links, which needn't
 * carry the project). Derives the project, then loads the same detail data. */
export async function loadTaskById(
  taskId: string,
): Promise<TaskDetailData | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) return null;
  return getTaskDetailData(task.projectId, taskId);
}

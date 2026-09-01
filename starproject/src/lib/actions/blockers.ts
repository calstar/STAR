"use server";

import { revalidatePath } from "next/cache";

import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";

export type BlockerFormState = { error?: string; ok?: boolean };

// Adding "taskId is blocked by blockedById" makes a cycle iff blockedById
// already (transitively) depends on taskId. Walk blockedById's own blockers.
async function wouldCycle(taskId: string, blockedById: string): Promise<boolean> {
  const seen = new Set<string>();
  let frontier = [blockedById];
  while (frontier.length) {
    const edges = await prisma.taskBlocker.findMany({
      where: { taskId: { in: frontier } },
      select: { blockedById: true },
    });
    const nextIds: string[] = [];
    for (const e of edges) {
      if (e.blockedById === taskId) return true;
      if (!seen.has(e.blockedById)) {
        seen.add(e.blockedById);
        nextIds.push(e.blockedById);
      }
    }
    frontier = nextIds;
  }
  return false;
}

function revalidateFor(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/tasks");
  revalidatePath("/activity");
}

export async function addBlockerAction(
  _prev: BlockerFormState,
  formData: FormData,
): Promise<BlockerFormState> {
  const user = await getCurrentDbUser();
  const taskId = String(formData.get("taskId") ?? "");
  const blockedById = String(formData.get("blockedById") ?? "");

  if (!taskId || !blockedById) return { error: "Pick a task to add." };
  if (taskId === blockedById) return { error: "A task can't block itself." };

  const [task, blocker] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, title: true },
    }),
    prisma.task.findUnique({
      where: { id: blockedById },
      select: { projectId: true, title: true },
    }),
  ]);
  if (!task || !blocker) return { error: "Task not found." };
  if (task.projectId !== blocker.projectId)
    return { error: "Blockers must be in the same project." };

  const existing = await prisma.taskBlocker.findUnique({
    where: { taskId_blockedById: { taskId, blockedById } },
  });
  if (existing) return { error: "That blocker is already added." };

  if (await wouldCycle(taskId, blockedById))
    return { error: "That would create a circular dependency." };

  await prisma.taskBlocker.create({ data: { taskId, blockedById } });
  await recordActivity({
    actorId: user.id,
    taskId,
    projectId: task.projectId,
    taskTitle: task.title,
    kind: "blocker_added",
    to: blocker.title,
  });
  revalidateFor(task.projectId);
  return { ok: true };
}

export async function removeBlocker(formData: FormData) {
  const user = await getCurrentDbUser();
  const taskId = String(formData.get("taskId"));
  const blockedById = String(formData.get("blockedById"));

  const edge = await prisma.taskBlocker.findUnique({
    where: { taskId_blockedById: { taskId, blockedById } },
    select: {
      task: { select: { projectId: true, title: true } },
      blockedByTask: { select: { title: true } },
    },
  });
  if (!edge) return;

  await prisma.taskBlocker.delete({
    where: { taskId_blockedById: { taskId, blockedById } },
  });
  await recordActivity({
    actorId: user.id,
    taskId,
    projectId: edge.task.projectId,
    taskTitle: edge.task.title,
    kind: "blocker_removed",
    to: edge.blockedByTask.title,
  });
  revalidateFor(edge.task.projectId);
}

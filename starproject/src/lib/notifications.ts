import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/mail";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function taskLink(projectId: string, taskId: string): string {
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const path = `/projects/${projectId}/tasks/${taskId}`;
  return base ? base + path : path;
}

/**
 * Email a task's assignee that it was assigned to them. Skipped when the
 * assignee is the person who made the change (no point emailing yourself).
 */
export async function notifyAssignment({
  taskId,
  assigneeId,
  actorId,
}: {
  taskId: string;
  assigneeId: string;
  actorId: string;
}): Promise<void> {
  if (assigneeId === actorId) return;

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { id: true, name: true } },
      assignee: { select: { id: true, email: true, name: true } },
    },
  });
  if (!task || !task.assignee || task.assignee.id !== assigneeId) return;

  const link = taskLink(task.projectId, task.id);
  const ok = await sendEmail({
    to: task.assignee.email,
    subject: `Assigned: ${task.title}`,
    html: `<p>You were assigned <strong>${escapeHtml(task.title)}</strong> in ${escapeHtml(
      task.project.name,
    )}.</p><p><a href="${link}">Open the task</a></p>`,
    text: `You were assigned "${task.title}" in ${task.project.name}.\n${link}`,
  });
  if (ok) {
    await prisma.notifLog.create({
      data: { taskId: task.id, userId: assigneeId, kind: "assigned" },
    });
  }
}

/**
 * Nightly deadline scan. Emails assignees of tasks that are overdue or due
 * today/tomorrow, once per (task, user, kind) — idempotent via NotifLog.
 */
export async function runDeadlineScan(): Promise<{
  dueSoon: number;
  overdue: number;
}> {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  // Exclusive upper bound: start of the day after tomorrow → includes today + tomorrow.
  const endWindow = new Date(startOfToday);
  endWindow.setDate(endWindow.getDate() + 2);

  const tasks = await prisma.task.findMany({
    where: {
      status: { not: "done" },
      assigneeId: { not: null },
      dueDate: { lt: endWindow }, // overdue or due-soon; far-future excluded
    },
    include: {
      project: { select: { id: true, name: true } },
      assignee: { select: { id: true, email: true, name: true } },
    },
  });

  let dueSoon = 0;
  let overdue = 0;

  for (const t of tasks) {
    if (!t.assignee || !t.dueDate) continue;
    const kind = t.dueDate < startOfToday ? "overdue" : "due_soon";

    const already = await prisma.notifLog.findFirst({
      where: { taskId: t.id, userId: t.assignee.id, kind },
    });
    if (already) continue;

    const link = taskLink(t.projectId, t.id);
    const dueStr = t.dueDate.toISOString().slice(0, 10);
    const word = kind === "overdue" ? "overdue" : "due soon";
    const ok = await sendEmail({
      to: t.assignee.email,
      subject: `${kind === "overdue" ? "Overdue" : "Due soon"}: ${t.title}`,
      html: `<p><strong>${escapeHtml(t.title)}</strong> in ${escapeHtml(
        t.project.name,
      )} is ${word} (due ${dueStr}).</p><p><a href="${link}">Open the task</a></p>`,
      text: `"${t.title}" in ${t.project.name} is ${word} (due ${dueStr}).\n${link}`,
    });
    if (!ok) continue;

    await prisma.notifLog.create({
      data: { taskId: t.id, userId: t.assignee.id, kind },
    });
    if (kind === "overdue") overdue++;
    else dueSoon++;
  }

  return { dueSoon, overdue };
}

import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/mail";
import { displayNameOf } from "@/lib/names";
import { getSettings } from "@/lib/settings";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function taskLink(projectId: string, taskId: string): string {
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  // There is no per-task page — a task opens as a modal over its project page,
  // keyed by `?task=<id>` (same shape as the in-app "Copy link" button).
  const path = `/projects/${projectId}?task=${taskId}`;
  return base ? base + path : path;
}

/**
 * Queue an assignment notification (skipped for self-assignment or when the
 * recipient disabled assignment emails). Not sent immediately — flushed as one
 * batched email per recipient by runEmailBatch() every 15 minutes.
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
    select: { id: true, title: true, projectId: true, assigneeId: true },
  });
  if (!task || task.assigneeId !== assigneeId) return;

  const settings = await getSettings(assigneeId);
  if (!settings.emailAssignments) return;

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true, displayName: true },
  });

  await prisma.emailQueueItem.create({
    data: {
      userId: assigneeId,
      kind: "assigned",
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      actorName: actor ? displayNameOf(actor) : null,
    },
  });
}

/**
 * Flush the assignment queue: one email per recipient covering everything queued
 * since the last run. Run every 15 minutes to conserve SES sends (100 tasks
 * assigned to someone in a window → one email).
 */
export async function runEmailBatch(): Promise<{
  emails: number;
  items: number;
}> {
  const items = await prisma.emailQueueItem.findMany({
    where: { sentAt: null },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (items.length === 0) return { emails: 0, items: 0 };

  const byUser = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byUser.get(it.userId) ?? [];
    arr.push(it);
    byUser.set(it.userId, arr);
  }

  let emails = 0;
  for (const group of byUser.values()) {
    const to = group[0].user.email;
    const rows = group.map((g) => ({
      title: escapeHtml(g.taskTitle),
      plain: g.taskTitle,
      link: g.taskId && g.projectId ? taskLink(g.projectId, g.taskId) : "",
      actor: g.actorName,
    }));
    const subject =
      group.length === 1
        ? `Assigned: ${group[0].taskTitle}`
        : `${group.length} tasks assigned to you`;
    const html =
      `<p>You were assigned:</p><ul>` +
      rows
        .map(
          (r) =>
            `<li><a href="${r.link}">${r.title}</a>${
              r.actor ? ` — by ${escapeHtml(r.actor)}` : ""
            }</li>`,
        )
        .join("") +
      `</ul>`;
    const text =
      `You were assigned:\n` +
      rows
        .map(
          (r) =>
            `- ${r.plain}${r.actor ? ` (by ${r.actor})` : ""}\n  ${r.link}`,
        )
        .join("\n");

    const ok = await sendEmail({ to, subject, html, text });
    if (ok) {
      await prisma.emailQueueItem.updateMany({
        where: { id: { in: group.map((g) => g.id) } },
        data: { sentAt: new Date() },
      });
      emails++;
    }
  }

  return { emails, items: items.length };
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

    const settings = await getSettings(t.assignee.id);
    if (kind === "due_soon" && !settings.emailDueSoon) continue;
    if (kind === "overdue" && !settings.emailOverdue) continue;

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

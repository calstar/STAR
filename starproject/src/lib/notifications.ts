import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/mail";
import { displayNameOf } from "@/lib/names";
import { PCB_STAGE_LABEL, type PcbStageKey, type PcbStageState, currentStage } from "@/lib/pcb";
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
    select: {
      id: true,
      title: true,
      projectId: true,
      assignees: { select: { id: true } },
    },
  });
  if (!task || !task.assignees.some((a) => a.id === assigneeId)) return;

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
 * today/tomorrow, once per (task, user, kind) — idempotent via NotifLog. On a
 * PCB board it is the current stage's people, about that stage's date.
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

  const person = { select: { id: true, email: true, name: true } } as const;
  const [plain, boards] = await Promise.all([
    prisma.task.findMany({
      where: {
        status: { not: "done" },
        assignees: { some: {} }, // has at least one assignee
        dueDate: { lt: endWindow }, // overdue or due-soon; far-future excluded
      },
      include: {
        project: { select: { id: true, name: true } },
        assignees: person,
        pcb: { select: { stages: { select: { stage: true, status: true } } } },
      },
    }),
    // A PCB board's deadline is its current stage's, which can fall well
    // before the task's own (the last stage's), so boards are read apart.
    prisma.task.findMany({
      where: {
        status: { not: "done" },
        pcb: { stages: { some: { status: "open", dueDate: { lt: endWindow } } } },
      },
      include: {
        project: { select: { id: true, name: true } },
        pcb: { select: { stages: { include: { assignees: person } } } },
      },
    }),
  ]);

  // Each deadline: who to tell, about what. A PCB board with a stage still
  // open is told about that stage only, to that stage's people, and logged per
  // stage ("overdue:layout") so each stage gets its own reminder.
  type Deadline = {
    task: { id: string; projectId: string; title: string; project: { name: string } };
    due: Date;
    stage: PcbStageKey | null;
    people: { id: string; email: string; name: string | null }[];
  };
  const deadlines: Deadline[] = [];
  for (const t of plain) {
    if (!t.dueDate) continue;
    if (t.pcb && currentStage(t.pcb.stages as { stage: PcbStageKey; status: PcbStageState }[])) continue;
    deadlines.push({ task: t, due: t.dueDate, stage: null, people: t.assignees });
  }
  for (const t of boards) {
    const cur = currentStage(
      (t.pcb?.stages ?? []).map((s) => ({ ...s, stage: s.stage as PcbStageKey, status: s.status as PcbStageState })),
    );
    if (!cur?.dueDate || cur.dueDate >= endWindow) continue;
    deadlines.push({ task: t, due: cur.dueDate, stage: cur.stage, people: cur.assignees });
  }

  let dueSoon = 0;
  let overdue = 0;

  for (const { task: t, due, stage, people } of deadlines) {
    const late = due < startOfToday;
    const kind = `${late ? "overdue" : "due_soon"}${stage ? `:${stage}` : ""}`;
    const what = stage ? `${PCB_STAGE_LABEL[stage]} for ${t.title}` : t.title;

    // One email per assignee, deduped per (task, user, kind) via NotifLog.
    for (const assignee of people) {
      const settings = await getSettings(assignee.id);
      if (!late && !settings.emailDueSoon) continue;
      if (late && !settings.emailOverdue) continue;

      const already = await prisma.notifLog.findFirst({
        where: { taskId: t.id, userId: assignee.id, kind },
      });
      if (already) continue;

      const link = taskLink(t.projectId, t.id);
      const dueStr = due.toISOString().slice(0, 10);
      const word = late ? "overdue" : "due soon";
      const ok = await sendEmail({
        to: assignee.email,
        subject: `${late ? "Overdue" : "Due soon"}: ${what}`,
        html: `<p><strong>${escapeHtml(what)}</strong> in ${escapeHtml(
          t.project.name,
        )} is ${word} (due ${dueStr}).</p><p><a href="${link}">Open the task</a></p>`,
        text: `"${what}" in ${t.project.name} is ${word} (due ${dueStr}).\n${link}`,
      });
      if (!ok) continue;

      await prisma.notifLog.create({
        data: { taskId: t.id, userId: assignee.id, kind },
      });
      if (late) overdue++;
      else dueSoon++;
    }
  }

  return { dueSoon, overdue };
}

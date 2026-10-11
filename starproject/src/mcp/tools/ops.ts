import { z } from "zod";

import { requireAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { runDigest } from "@/lib/digest";
import { runDeadlineScan, runEmailBatch } from "@/lib/notifications";

import { READ, WRITE, defineTool, type ToolModule } from "./_shared";

// The jobs the starproject-cron sidecar triggers (src/app/api/cron/*), plus a
// look at the queues they drain. Every tool here is admins only: the cron routes
// are gated by CRON_SECRET, and this is the same lever in a person's hands.
// `requireAdmin` throws "Forbidden: admins only", which defineTool turns into an
// isError result.

const limit = z.number().int().min(1).max(500).default(100).describe("Rows to return, newest last for the queue, newest first for the log");

export const opsTools: ToolModule = (server) => {
  defineTool(
    server,
    "run_email_batch",
    {
      description:
        "Admins only. Flush the assignment-email queue now: one email per recipient covering everything queued " +
        "since the last run (what the cron sidecar does every 15 minutes via POST /api/cron/email-batch). " +
        "Email is a no-op when SES_FROM is unset, in which case nothing is sent and the queue is left as is.",
      inputSchema: {},
      annotations: WRITE,
    },
    async () => {
      await requireAdmin();
      return runEmailBatch();
    },
  );

  defineTool(
    server,
    "run_deadline_scan",
    {
      description:
        "Admins only. Run the nightly deadline scan now: emails assignees of tasks that are overdue or due today/tomorrow, " +
        "once per (task, user, kind) via NotifLog (POST /api/cron/deadlines). No-op when SES_FROM is unset.",
      inputSchema: {},
      annotations: WRITE,
    },
    async () => {
      await requireAdmin();
      return runDeadlineScan();
    },
  );

  defineTool(
    server,
    "run_digest",
    {
      description:
        "Admins only. Send the nightly digest now: for each user following a project or subteam, the last 24h of " +
        "activity there filtered to their chosen kinds (POST /api/cron/digest). No-op when SES_FROM is unset.",
      inputSchema: {},
      annotations: WRITE,
    },
    async () => {
      await requireAdmin();
      return runDigest();
    },
  );

  defineTool(
    server,
    "list_email_queue",
    {
      description:
        "Admins only. Assignment emails queued and not yet sent (EmailQueueItem with sentAt null), oldest first: " +
        "recipient email, kind, task title, when it was queued. This is what run_email_batch would flush.",
      inputSchema: { limit },
      annotations: READ,
    },
    async ({ limit }) => {
      await requireAdmin();
      const items = await prisma.emailQueueItem.findMany({
        where: { sentAt: null },
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return items.map((it) => ({
        id: it.id,
        userEmail: it.user.email,
        kind: it.kind,
        taskId: it.taskId,
        taskTitle: it.taskTitle,
        projectId: it.projectId,
        actorName: it.actorName,
        createdAt: it.createdAt.toISOString(),
      }));
    },
  );

  defineTool(
    server,
    "list_notification_log",
    {
      description:
        "Admins only. The most recent deadline emails sent (NotifLog, the idempotency ledger the deadline scan " +
        "checks so it never double-sends): task, recipient, kind (due_soon | overdue), when. Newest first.",
      inputSchema: { limit },
      annotations: READ,
    },
    async ({ limit }) => {
      await requireAdmin();
      const rows = await prisma.notifLog.findMany({ orderBy: { sentAt: "desc" }, take: limit });
      // NotifLog keeps bare ids (the task may be gone by now); label what still exists.
      const [users, tasks] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
          select: { id: true, email: true },
        }),
        prisma.task.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.taskId))] } },
          select: { id: true, number: true, title: true },
        }),
      ]);
      const emailOf = new Map(users.map((u) => [u.id, u.email]));
      const taskOf = new Map(tasks.map((t) => [t.id, t]));
      return rows.map((r) => {
        const task = taskOf.get(r.taskId);
        return {
          id: r.id,
          taskId: r.taskId,
          taskNumber: task?.number ?? null,
          taskTitle: task?.title ?? null,
          userId: r.userId,
          userEmail: emailOf.get(r.userId) ?? null,
          kind: r.kind,
          sentAt: r.sentAt.toISOString(),
        };
      });
    },
  );
};

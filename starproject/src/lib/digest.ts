import { FIELD_LABEL } from "@/lib/activity";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/mail";

type Act = {
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  taskTitle: string;
  projectId: string | null;
  task: { subteamId: string | null } | null;
  actor: { name: string | null; email: string };
};

// Digest "activity kinds" the user can subscribe to (UserSettings.digestKinds).
export const DIGEST_KINDS: [string, string][] = [
  ["created", "Task created"],
  ["status", "Status changes"],
  ["assignee", "Assignments"],
  ["priority", "Priority changes"],
  ["due", "Due-date changes"],
  ["blockers", "Blocker changes"],
  ["deleted", "Task deleted"],
];

function matches(a: Act, kinds: string[]): boolean {
  if (a.kind === "created") return kinds.includes("created");
  if (a.kind === "deleted") return kinds.includes("deleted");
  if (a.kind === "blocker_added" || a.kind === "blocker_removed")
    return kinds.includes("blockers");
  if (a.kind === "updated") return kinds.includes(a.field ?? "");
  return false;
}

function line(a: Act): string {
  const who = a.actor.name ?? a.actor.email;
  switch (a.kind) {
    case "created":
      return `${who} created “${a.taskTitle}”`;
    case "deleted":
      return `${who} deleted “${a.taskTitle}”`;
    case "blocker_added":
      return `${who} added a blocker to “${a.taskTitle}”: ${a.toValue ?? ""}`;
    case "blocker_removed":
      return `${who} removed a blocker from “${a.taskTitle}”: ${a.toValue ?? ""}`;
    case "updated":
      return `${who} changed ${FIELD_LABEL[a.field ?? ""] ?? a.field} of “${a.taskTitle}” from ${a.fromValue ?? "—"} to ${a.toValue ?? "—"}`;
    default:
      return `${who} updated “${a.taskTitle}”`;
  }
}

/**
 * Nightly digest: for each user who follows any project/subteam, email a summary
 * of the last 24h of activity in those, filtered to their chosen activity kinds.
 */
export async function runDigest(): Promise<{ emails: number }> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [users, activities] = await Promise.all([
    prisma.user.findMany({
      where: { digestSubscriptions: { some: {} } },
      include: { settings: true, digestSubscriptions: true },
    }),
    prisma.activity.findMany({
      where: { createdAt: { gte: since } },
      include: {
        task: { select: { subteamId: true } },
        actor: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  let emails = 0;
  for (const u of users) {
    const kinds = u.settings?.digestKinds ?? [];
    if (kinds.length === 0) continue;
    const projIds = new Set(
      u.digestSubscriptions
        .map((s) => s.projectId)
        .filter((x): x is string => !!x),
    );
    const subIds = new Set(
      u.digestSubscriptions
        .map((s) => s.subteamId)
        .filter((x): x is string => !!x),
    );

    const matched = activities.filter((a) => {
      const inProj = !!a.projectId && projIds.has(a.projectId);
      const inSub = !!a.task?.subteamId && subIds.has(a.task.subteamId);
      return (inProj || inSub) && matches(a, kinds);
    });
    if (matched.length === 0) continue;

    const lines = matched.map(line);
    const html =
      `<p>Here's what happened in the last day in the projects and subteams you follow:</p><ul>` +
      lines
        .map(
          (l) => `<li>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`,
        )
        .join("") +
      `</ul>`;
    const text =
      `Daily digest — ${matched.length} update(s):\n` +
      lines.map((l) => `- ${l}`).join("\n");

    const ok = await sendEmail({
      to: u.email,
      subject: `Your daily digest (${matched.length} update${matched.length === 1 ? "" : "s"})`,
      html,
      text,
    });
    if (ok) emails++;
  }
  return { emails };
}

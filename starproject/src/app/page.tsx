import Link from "next/link";

import { BlockedBadge } from "@/components/BlockedBadge";
import { PAGE_CONTAINER } from "@/components/EntityRow";
import { ProgramBoard } from "@/components/ProgramBoard";
import { TaskLink } from "@/components/TaskLink";
import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { firstNameOf } from "@/lib/names";
import { getProgramCards } from "@/lib/program-data";
import { STATUS_BADGE, STATUS_LABEL, isBlocked } from "@/lib/tasks";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// The team is Berkeley-based; the greeting should read local time-of-day
// regardless of which region the server itself runs in.
const BERKELEY_TZ = "America/Los_Angeles";

function greeting(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: BERKELEY_TZ }).format(now),
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: BERKELEY_TZ,
  }).format(now);
}

export default async function Home() {
  const user = await getCurrentDbUser();
  const now = new Date();

  // Projects and subteams are only needed here as pickers for the program
  // board; the sidebar already lists both.
  const [projects, subteams, myTasks, cards, admin] = await Promise.all([
    prisma.project.findMany({
      where: { archived: false, parentId: null },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.subteam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.task.findMany({
      where: { archived: false, assignees: { some: { id: user.id } } },
      include: {
        project: { select: { id: true, name: true } },
        blockedBy: { include: { blockedByTask: { select: { status: true } } } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    }),
    getProgramCards(),
    isAdmin(user.email),
  ]);
  // Deadlines count down in Berkeley days, not the server's.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: BERKELEY_TZ }).format(now);

  const tile =
    "rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900";
  const seeAll =
    "inline-flex min-h-11 items-center text-xs text-neutral-500 hover:underline dark:text-neutral-400 sm:min-h-0";

  return (
    <div className={PAGE_CONTAINER}>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{todayLabel(now)}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">
        {greeting(now)}, {firstNameOf(user)}
      </h1>

      {/* My tasks — the reason they opened the app, so it leads. */}
      <section className={`mt-8 ${tile}`}>
        <div className="flex items-center justify-between">
          <h2 className="font-medium">My tasks</h2>
          <Link href="/tasks?mine=1" className={seeAll}>
            All →
          </Link>
        </div>
        <div className="mt-3 space-y-0.5">
          {myTasks.length === 0 && (
            <p className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400">
              Nothing assigned to you. Nice.
            </p>
          )}
          {myTasks.map((t) => {
            const due = t.dueDate ? new Date(t.dueDate) : null;
            const overdue =
              due != null && t.status !== "done" && due.getTime() < Date.now();
            return (
              <TaskLink
                key={t.id}
                projectId={t.projectId}
                taskId={t.id}
                className="block w-full rounded-lg px-2 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {t.title}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[t.status]}`}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="truncate">{t.project.name}</span>
                  {due && (
                    <span
                      className={overdue ? "font-medium text-red-600" : ""}
                    >
                      {due.toISOString().slice(0, 10)}
                    </span>
                  )}
                  {isBlocked(t.blockedBy) && <BlockedBadge />}
                </div>
              </TaskLink>
            );
          })}
        </div>
      </section>

      <div className="mt-6">
        <ProgramBoard
          cards={cards}
          isAdmin={admin}
          today={today}
          candidates={projects}
          allSubteams={subteams}
        />
      </div>
    </div>
  );
}

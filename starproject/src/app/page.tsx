import Link from "next/link";

import { BlockedBadge } from "@/components/BlockedBadge";
import { prisma } from "@/lib/db";
import { STATUS_BADGE, STATUS_LABEL, isBlocked } from "@/lib/tasks";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentDbUser();

  const [projects, subteams, myTasks] = await Promise.all([
    prisma.project.findMany({
      where: { archived: false, parentId: null },
      include: { _count: { select: { tasks: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.subteam.findMany({
      include: { _count: { select: { tasks: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.task.findMany({
      where: { assigneeId: user.id, status: { not: "done" } },
      include: {
        project: { select: { id: true, name: true } },
        blockedBy: { include: { blockedByTask: { select: { status: true } } } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      take: 25,
    }),
  ]);

  const tile =
    "rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900";
  const rowLink =
    "flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800";
  const seeAll =
    "text-xs text-neutral-500 hover:underline dark:text-neutral-400";
  const count = "shrink-0 text-xs text-neutral-500 dark:text-neutral-400";
  const dot = "inline-block h-3 w-3 shrink-0 rounded-full";

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold">
        Home
        <span className="ml-2 text-base font-normal text-neutral-500 dark:text-neutral-400">
          {user.name ?? user.email}
        </span>
      </h1>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {/* Projects */}
        <section className={tile}>
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Projects</h2>
            <Link href="/projects" className={seeAll}>
              All →
            </Link>
          </div>
          <div className="mt-3 max-h-[28rem] space-y-0.5 overflow-y-auto">
            {projects.length === 0 && (
              <p className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400">
                No projects yet.
              </p>
            )}
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className={rowLink}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={dot}
                    style={{ background: p.color ?? "#a3a3a3" }}
                  />
                  <span className="truncate text-sm font-medium">{p.name}</span>
                </span>
                <span className={count}>{p._count.tasks}</span>
              </Link>
            ))}
          </div>
        </section>

        {/* Subteams */}
        <section className={tile}>
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Subteams</h2>
            <Link href="/subteams" className={seeAll}>
              All →
            </Link>
          </div>
          <div className="mt-3 max-h-[28rem] space-y-0.5 overflow-y-auto">
            {subteams.length === 0 && (
              <p className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400">
                No subteams yet.
              </p>
            )}
            {subteams.map((s) => (
              <Link key={s.id} href={`/subteams/${s.id}`} className={rowLink}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={dot}
                    style={{ background: s.color ?? "#a3a3a3" }}
                  />
                  <span className="truncate text-sm font-medium">{s.name}</span>
                </span>
                <span className={count}>{s._count.tasks}</span>
              </Link>
            ))}
          </div>
        </section>

        {/* My tasks */}
        <section className={tile}>
          <div className="flex items-center justify-between">
            <h2 className="font-medium">My tasks</h2>
            <Link href="/tasks" className={seeAll}>
              All →
            </Link>
          </div>
          <div className="mt-3 max-h-[28rem] space-y-0.5 overflow-y-auto">
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
                <Link
                  key={t.id}
                  href={`/projects/${t.projectId}/tasks/${t.id}`}
                  className="block rounded-lg px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

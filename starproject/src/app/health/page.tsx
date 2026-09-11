import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

// Ops sanity check: identity (with the user's display name) + a live DB
// round-trip. The root layout already loads the DB user, so this page is
// DB-dependent regardless.
export const dynamic = "force-dynamic";

type Health = { ok: boolean; detail: string };

async function checkDb(): Promise<Health> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [users, projects, tasks] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.task.count(),
    ]);
    return {
      ok: true,
      detail: `connected — ${users} user(s), ${projects} project(s), ${tasks} task(s)`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function Health() {
  const user = await getCurrentDbUser();
  const db = await checkDb();

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 sm:px-6 py-6 sm:py-10">
      <h1 className="text-xl font-semibold">Health</h1>

      <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Signed in as</h2>
        <p className="mt-1 text-lg font-medium">{displayNameOf(user)}</p>
        <p className="text-neutral-600 dark:text-neutral-300">{user.email}</p>
      </section>

      <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Database</h2>
        <p className="mt-1 flex items-center gap-2 text-lg font-medium">
          <span
            aria-hidden
            className={
              "inline-block h-2.5 w-2.5 rounded-full " +
              (db.ok ? "bg-green-500" : "bg-red-500")
            }
          />
          {db.ok ? "Healthy" : "Unavailable"}
        </p>
        <p className="mt-1 break-words text-sm text-neutral-600 dark:text-neutral-300">{db.detail}</p>
      </section>
    </main>
  );
}

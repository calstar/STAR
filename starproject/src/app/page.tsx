import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Reads request headers + the DB per request, so this route is always dynamic.
export const dynamic = "force-dynamic";

type Health = { ok: boolean; detail: string };

async function checkDb(): Promise<Health> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const users = await prisma.user.count();
    return { ok: true, detail: `connected — ${users} user record(s)` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function Home() {
  const user = await getCurrentUser();
  const db = await checkDb();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          STARProject
        </p>
        <h1 className="mt-1 text-3xl font-semibold">Phase 0 — it&apos;s alive</h1>
      </div>

      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium text-neutral-500">Signed in as</h2>
        <p className="mt-1 text-lg font-medium">{user.name}</p>
        <p className="text-neutral-600">{user.email}</p>
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-medium text-neutral-500">Database</h2>
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
        <p className="mt-1 break-words text-sm text-neutral-600">{db.detail}</p>
      </section>
    </main>
  );
}

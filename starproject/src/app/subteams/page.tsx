import Link from "next/link";

import { createSubteam, deleteSubteam } from "@/lib/actions/subteams";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SubteamsPage() {
  const subteams = await prisma.subteam.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { tasks: true } } },
  });

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Subteams</h1>
      <p className="mt-1 text-sm text-neutral-500">
        A subteam is a task tag, a peer to projects. Filter the Tasks view by one
        to see everything it owns across every project.
      </p>

      <form
        action={createSubteam}
        className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white p-3"
      >
        <input
          name="name"
          required
          placeholder="New subteam name"
          className="min-w-48 flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm"
        />
        <input
          type="color"
          name="color"
          defaultValue="#0ea5e9"
          aria-label="Subteam color"
          className="h-9 w-10 rounded border border-neutral-300"
        />
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
          Create
        </button>
      </form>

      <ul className="mt-6 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {subteams.length === 0 && (
          <li className="p-4 text-neutral-500">
            No subteams yet. Create one above.
          </li>
        )}
        {subteams.map((s) => (
          <li key={s.id} className="flex items-center justify-between p-4">
            <span className="flex items-center gap-3">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: s.color ?? "#a3a3a3" }}
              />
              <Link
                href={`/tasks?subteam=${s.id}`}
                className="font-medium hover:underline"
              >
                {s.name}
              </Link>
              <span className="text-sm text-neutral-500">
                {s._count.tasks} task{s._count.tasks === 1 ? "" : "s"}
              </span>
            </span>
            <div className="flex items-center gap-4">
              <Link
                href={`/tasks?subteam=${s.id}`}
                className="text-sm text-neutral-500 hover:underline"
              >
                View in Tasks →
              </Link>
              <form action={deleteSubteam}>
                <input type="hidden" name="id" value={s.id} />
                <button className="text-sm text-red-600 hover:underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

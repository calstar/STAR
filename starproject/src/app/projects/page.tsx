import Link from "next/link";

import { NewProjectForm } from "@/components/NewProjectForm";
import { prisma } from "@/lib/db";

// Reads the DB per request.
export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await prisma.project.findMany({
    where: { archived: false, parentId: null },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { tasks: true } },
      children: {
        where: { archived: false },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { tasks: true } } },
      },
    },
  });
  const parents = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Projects</h1>

      <div className="mt-4">
        <NewProjectForm parents={parents} />
      </div>

      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        {projects.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No projects yet. Create one above.
          </li>
        )}
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${p.id}`}
              className="flex items-center justify-between p-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <span className="flex items-center gap-3">
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ background: p.color ?? "#a3a3a3" }}
                />
                <span className="font-medium">{p.name}</span>
                {p.description && (
                  <span className="text-sm text-neutral-500 dark:text-neutral-400">
                    {p.description}
                  </span>
                )}
              </span>
              <span className="text-sm text-neutral-500 dark:text-neutral-400">
                {p._count.tasks} task{p._count.tasks === 1 ? "" : "s"}
              </span>
            </Link>

            {p.children.length > 0 && (
              <ul className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/60">
                {p.children.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/projects/${c.id}`}
                      className="flex items-center justify-between py-2.5 pl-10 pr-4 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      <span className="flex items-center gap-3">
                        <span className="text-neutral-300">↳</span>
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: c.color ?? "#a3a3a3" }}
                        />
                        <span className="text-sm font-medium">{c.name}</span>
                      </span>
                      <span className="text-sm text-neutral-500 dark:text-neutral-400">
                        {c._count.tasks} task{c._count.tasks === 1 ? "" : "s"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

import Link from "next/link";

import { NewProjectForm } from "@/components/NewProjectForm";
import { prisma } from "@/lib/db";

// Reads the DB per request.
export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await prisma.project.findMany({
    where: { archived: false },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { tasks: true } } },
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Projects</h1>

      <div className="mt-4">
        <NewProjectForm />
      </div>

      <ul className="mt-6 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {projects.length === 0 && (
          <li className="p-4 text-neutral-500">
            No projects yet. Create one above.
          </li>
        )}
        {projects.map((p) => (
          <li key={p.id} className="hover:bg-neutral-50">
            <Link
              href={`/projects/${p.id}`}
              className="flex items-center justify-between p-4"
            >
              <span className="flex items-center gap-3">
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ background: p.color ?? "#a3a3a3" }}
                />
                <span className="font-medium">{p.name}</span>
                {p.description && (
                  <span className="text-sm text-neutral-500">
                    {p.description}
                  </span>
                )}
              </span>
              <span className="text-sm text-neutral-500">
                {p._count.tasks} task{p._count.tasks === 1 ? "" : "s"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

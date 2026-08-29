import { Fragment } from "react";

import { EntityRow, LIST_CARD } from "@/components/EntityRow";
import { prisma } from "@/lib/db";

// Reads the DB per request.
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
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

  return (
    <div className="mx-auto max-w-[88rem] px-6 py-8">
      <h1 className="text-2xl font-semibold">Projects</h1>

      <ul className={LIST_CARD}>
        {projects.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No projects yet. An admin can create one in Workspace setup.
          </li>
        )}
        {projects.map((p) => (
          <Fragment key={p.id}>
            <EntityRow
              href={`/projects/${p.id}`}
              color={p.color}
              name={p.name}
              description={p.description}
              taskCount={p._count.tasks}
              id={p.id}
            />
            {p.children.map((c) => (
              <EntityRow
                key={c.id}
                href={`/projects/${c.id}`}
                color={c.color}
                name={c.name}
                taskCount={c._count.tasks}
                id={c.id}
                indent
              />
            ))}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

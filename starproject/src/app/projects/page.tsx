import { EntityRow, LIST_CARD, PAGE_CONTAINER } from "@/components/EntityRow";
import { prisma } from "@/lib/db";
import { flatten, totalTasks } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";

// Reads the DB per request.
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const [tree, counts, details] = await Promise.all([
    getProjectTree(),
    prisma.task.groupBy({ by: ["projectId"], _count: { _all: true } }),
    prisma.project.findMany({
      where: { archived: false, parentId: null },
      select: { id: true, description: true },
    }),
  ]);
  const own = new Map(counts.map((c) => [c.projectId, c._count._all]));
  const description = new Map(details.map((d) => [d.id, d.description]));
  // Newest top-level project first, as before; each one's subprojects follow
  // it, every level indented, in the order they were made.
  const rows = flatten(tree);
  const tops = rows.filter((r) => r.depth === 0).reverse();
  const ordered = tops.flatMap((top) => [
    top,
    ...flatten(tree, { under: top.node.id }).map((r) => ({ ...r, depth: r.depth + 1 })),
  ]);

  return (
    <div className={PAGE_CONTAINER}>
      <h1 className="text-2xl font-semibold">Projects</h1>

      <ul className={LIST_CARD}>
        {ordered.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No projects yet. An admin can create one in Workspace setup.
          </li>
        )}
        {ordered.map(({ node, depth }) => (
          <EntityRow
            key={node.id}
            href={`/projects/${node.id}`}
            color={node.color}
            name={node.name}
            description={depth === 0 ? description.get(node.id) : null}
            // A project's count includes everything under it, at every level.
            taskCount={totalTasks(tree, node.id, (id) => own.get(id) ?? 0)}
            id={node.id}
            depth={depth}
          />
        ))}
      </ul>
    </div>
  );
}

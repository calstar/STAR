import { EntityRow, LIST_CARD, PAGE_CONTAINER } from "@/components/EntityRow";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SubteamsPage() {
  const subteams = await prisma.subteam.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { tasks: true } } },
  });

  return (
    <div className={PAGE_CONTAINER}>
      <h1 className="text-2xl font-semibold">Subteams</h1>

      <ul className={LIST_CARD}>
        {subteams.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No subteams yet. An admin can create one in Workspace setup.
          </li>
        )}
        {subteams.map((s) => (
          <EntityRow
            key={s.id}
            href={`/subteams/${s.id}`}
            color={s.color}
            name={s.name}
            taskCount={s._count.tasks}
            id={s.id}
          />
        ))}
      </ul>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { NewTaskForm } from "@/components/NewTaskForm";
import { TaskRow } from "@/components/TaskRow";
import { deleteProject } from "@/lib/actions/projects";
import { prisma } from "@/lib/db";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [project, users] = await Promise.all([
    prisma.project.findUnique({
      where: { id },
      include: {
        tasks: {
          include: { assignee: true },
          orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        },
      },
    }),
    getTeamUsers(),
  ]);

  if (!project) notFound();

  const th = "px-2 py-2 font-medium";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{ background: project.color ?? "#a3a3a3" }}
            />
            <h1 className="text-2xl font-semibold">{project.name}</h1>
          </div>
          {project.description && (
            <p className="mt-1 text-neutral-600">{project.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Link href="/" className="text-sm text-neutral-500 hover:underline">
            ← All projects
          </Link>
          <form action={deleteProject}>
            <input type="hidden" name="id" value={project.id} />
            <button className="text-sm text-red-600 hover:underline">
              Delete project
            </button>
          </form>
        </div>
      </div>

      <div className="mt-6">
        <NewTaskForm projectId={project.id} users={users} />
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <th className={th}>Task</th>
              <th className={th}>Status</th>
              <th className={th}>Priority</th>
              <th className={th}>Assignee</th>
              <th className={th}>Due</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {project.tasks.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-neutral-500">
                  No tasks yet. Add one above.
                </td>
              </tr>
            )}
            {project.tasks.map((t) => (
              <TaskRow key={t.id} task={t} users={users} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";

import { EditEntityButton } from "@/components/EditEntityButton";
import { EntityRow, LIST_CARD } from "@/components/EntityRow";
import { NewProjectForm } from "@/components/NewProjectForm";
import { AdminConfig } from "@/components/settings/AdminConfig";
import { createSubteam, deleteSubteam, updateSubteam } from "@/lib/actions/subteams";
import { deleteProject, updateProject } from "@/lib/actions/projects";
import { isAdmin, listAdmins } from "@/lib/admins";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// Admin-only workspace setup: the rare, data-losing actions (create/remove
// projects and subteams) live here, off the everyday browse pages.
export default async function WorkspacePage() {
  const admin = await isAdmin((await getCurrentUser()).email);
  if (!admin) redirect("/settings");

  const [projects, subteams, admins] = await Promise.all([
    prisma.project.findMany({
      where: { archived: false },
      orderBy: [{ createdAt: "desc" }],
      include: {
        _count: { select: { tasks: true } },
        parent: { select: { name: true } },
      },
    }),
    prisma.subteam.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tasks: true } } },
    }),
    listAdmins(),
  ]);

  const parents = projects
    .filter((p) => !p.parentId)
    .map((p) => ({ id: p.id, name: p.name }));

  // Tasks contributed by each parent's subprojects, so a parent's badge sums all
  // tasks under it. (The delete message stays on the project's own count, since
  // deleting a parent re-parents its subprojects rather than deleting them.)
  const subprojectTasks = new Map<string, number>();
  for (const p of projects) {
    if (p.parentId)
      subprojectTasks.set(
        p.parentId,
        (subprojectTasks.get(p.parentId) ?? 0) + p._count.tasks,
      );
  }

  const heading = "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold">Workspace setup</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Create and remove projects and subteams. These actions can delete data,
        so they live here and are limited to admins.
      </p>

      {/* Projects */}
      <h2 className={`${heading} mt-8`}>Projects</h2>
      <div className="mt-2">
        <NewProjectForm parents={parents} />
      </div>
      <ul className={LIST_CARD}>
        {projects.length === 0 && (
          <li className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            No projects yet.
          </li>
        )}
        {projects.map((p) => (
          <EntityRow
            key={p.id}
            href={`/projects/${p.id}`}
            color={p.color}
            name={p.parent ? `${p.parent.name} › ${p.name}` : p.name}
            taskCount={p._count.tasks + (subprojectTasks.get(p.id) ?? 0)}
            id={p.id}
            deleteAction={deleteProject}
            deleteMessage={`This permanently deletes the project and its ${p._count.tasks} task${
              p._count.tasks === 1 ? "" : "s"
            }. This cannot be undone.`}
            editSlot={
              <EditEntityButton
                action={updateProject}
                id={p.id}
                name={p.name}
                color={p.color}
                description={p.description}
                showDescription
                title="Edit project"
              />
            }
          />
        ))}
      </ul>

      {/* Subteams */}
      <h2 className={`${heading} mt-8`}>Subteams</h2>
      <form
        action={createSubteam}
        className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3"
      >
        <input
          name="name"
          required
          placeholder="New subteam name"
          className="min-h-11 sm:min-h-0 basis-full sm:basis-auto sm:min-w-48 flex-1 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm"
        />
        <input
          type="color"
          name="color"
          defaultValue="#0ea5e9"
          aria-label="Subteam color"
          className="h-11 w-12 sm:h-9 sm:w-10 rounded border border-neutral-300 dark:border-neutral-700"
        />
        <button className="min-h-11 sm:min-h-0 rounded bg-neutral-900 px-4 sm:px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
          Create
        </button>
      </form>
      <ul className={LIST_CARD}>
        {subteams.length === 0 && (
          <li className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            No subteams yet.
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
            deleteAction={deleteSubteam}
            deleteMessage="This removes the subteam. Its tasks are kept but lose this tag."
            editSlot={
              <EditEntityButton
                action={updateSubteam}
                id={s.id}
                name={s.name}
                color={s.color}
                title="Edit subteam"
              />
            }
          />
        ))}
      </ul>

      {/* Admins */}
      <h2 className={`${heading} mt-8`}>Admins</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Admins can delete projects, subteams, and tasks. Add someone by their
        @berkeley.edu email.
      </p>
      <div className="mt-2">
        <AdminConfig admins={admins} />
      </div>
    </div>
  );
}

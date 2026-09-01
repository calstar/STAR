import type { User } from "@prisma/client";
import Link from "next/link";

import { Board } from "@/components/Board";
import { GanttChart } from "@/components/GanttChart";
import { TaskTable } from "@/components/TaskTable";
import { type WorkspaceTask, toRowData } from "@/lib/board";

export type DetailViewMode = "board" | "list" | "gantt";

// Shared detail layout for a project or subteam: an entity-specific header, then
// the identical List/Board/Timeline tabs + task views. Both pages render through
// this so their width, tabs, and task display can never drift apart again.
export function DetailView({
  basePath,
  view,
  tasks,
  users,
  admin,
  header,
  newTaskForm,
  emptyText,
  showProject = false,
  showSubteam = false,
}: {
  basePath: string;
  view: DetailViewMode;
  tasks: WorkspaceTask[];
  users: User[];
  admin: boolean;
  header: React.ReactNode;
  newTaskForm?: React.ReactNode;
  emptyText?: string;
  showProject?: boolean;
  showSubteam?: boolean;
}) {
  const tab = (active: boolean) =>
    `rounded px-3 py-1 text-sm ${
      active
        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;

  return (
    <div className="mx-auto max-w-[88rem] px-6 py-8">
      {header}

      <div className="mt-6 flex items-center gap-1">
        <Link href={basePath} className={tab(view === "list")}>
          List
        </Link>
        <Link href={`${basePath}?view=board`} className={tab(view === "board")}>
          Board
        </Link>
        <Link href={`${basePath}?view=gantt`} className={tab(view === "gantt")}>
          Timeline
        </Link>
      </div>

      {newTaskForm && <div className="mt-4">{newTaskForm}</div>}

      {view === "board" ? (
        <div className="mt-6">
          <Board tasks={tasks} />
        </div>
      ) : view === "gantt" ? (
        <div className="mt-6">
          <GanttChart tasks={tasks} />
        </div>
      ) : (
        <div className="mt-6">
          <TaskTable
            rows={tasks.map(toRowData)}
            users={users}
            admin={admin}
            showProject={showProject}
            showSubteam={showSubteam}
            emptyText={emptyText ?? "No tasks yet. Add one above."}
          />
        </div>
      )}
    </div>
  );
}

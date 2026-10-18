import type { User } from "@prisma/client";
import Link from "next/link";

import { BoardWithSort } from "@/components/BoardWithSort";
import { PAGE_CONTAINER } from "@/components/EntityRow";
import { GanttChart } from "@/components/GanttChart";
import { TaskTable } from "@/components/TaskTable";
import { ViewDock } from "@/components/ViewDock";
import { type WorkspaceTask, inLists, onBoard, toRowData } from "@/lib/board";

export type DetailViewMode = "board" | "list" | "gantt" | "bom";

// Shared detail layout for a project or subteam: an entity-specific header, then
// the identical List/Board/Timeline tabs + task views. Both pages render through
// this so their width, tabs, and task display can never drift apart again.
// `tasks` is what the board shows (open tasks and the recently done, see
// onBoard); the list and timeline show only the open ones.
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
  showSubproject = false,
  bom,
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
  showSubproject?: boolean;
  /** Project pages only: shows the BOM tab, and its body when view is "bom"
   * (null while another tab is showing, so the BOM isn't loaded for nothing). */
  bom?: { body: React.ReactNode | null };
}) {
  const tab = (active: boolean) =>
    `inline-flex items-center rounded px-3 py-1 text-sm ${
      active
        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;

  const boardTasks = tasks.filter((t) => onBoard(t));
  const openTasks = tasks.filter(inLists);

  return (
    // pb-24 keeps the last rows clear of the mobile ViewDock; sm:pb-8 restores
    // PAGE_CONTAINER's desktop bottom padding.
    <div className={`${PAGE_CONTAINER} pb-24 sm:pb-8`}>
      {header}

      {/* Desktop tabs; on mobile the ViewDock below replaces them. */}
      <div className="mt-6 hidden items-center gap-1 sm:flex">
        <Link href={basePath} className={tab(view === "list")}>
          List
        </Link>
        <Link href={`${basePath}?view=board`} className={tab(view === "board")}>
          Board
        </Link>
        <Link href={`${basePath}?view=gantt`} className={tab(view === "gantt")}>
          Timeline
        </Link>
        {bom && (
          <Link href={`${basePath}?view=bom`} className={tab(view === "bom")}>
            BOM
          </Link>
        )}
      </div>

      <ViewDock
        active={view}
        hrefs={{
          list: basePath,
          board: `${basePath}?view=board`,
          gantt: `${basePath}?view=gantt`,
          ...(bom ? { bom: `${basePath}?view=bom` } : {}),
        }}
      />

      {newTaskForm && view !== "bom" && <div className="mt-4">{newTaskForm}</div>}

      {view === "bom" && bom ? (
        <div className="mt-6 min-w-0">{bom.body}</div>
      ) : view === "board" ? (
        <div className="mt-6">
          <BoardWithSort tasks={boardTasks} />
        </div>
      ) : view === "gantt" ? (
        <div className="mt-6">
          <GanttChart tasks={openTasks} />
        </div>
      ) : (
        <div className="mt-6">
          <TaskTable
            rows={openTasks.map(toRowData)}
            users={users}
            admin={admin}
            showProject={showProject}
            showSubproject={showSubproject}
            emptyText={emptyText ?? "No tasks yet. Add one above."}
          />
        </div>
      )}
    </div>
  );
}

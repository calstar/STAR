"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { TaskStatus } from "@prisma/client";

import type { BoardTask } from "@/lib/board";

import { TaskCard } from "./TaskCard";

export function Column({
  status,
  label,
  tasks,
}: {
  status: TaskStatus;
  label: string;
  tasks: BoardTask[];
}) {
  // Droppable id is prefixed so the board can tell a column drop-target from a
  // task drop-target. Keeps empty columns valid drop zones.
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-xl bg-neutral-100 dark:bg-neutral-800 p-2">
      <div className="flex items-center justify-between px-2 py-1.5">
        <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{label}</h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{tasks.length}</span>
      </div>
      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={`flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors ${
            isOver ? "bg-neutral-200 dark:bg-neutral-700" : ""
          }`}
        >
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
          {tasks.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-neutral-400">
              Drop here
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

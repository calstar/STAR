"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef } from "react";

import { useTaskModal } from "@/components/TaskModalProvider";
import type { BoardTask } from "@/lib/board";
import { displayNameOf } from "@/lib/names";
import { PRIORITY_BADGE, isBlocked } from "@/lib/tasks";

import { BlockedBadge } from "./BlockedBadge";
import { SubprojectBadge } from "./SubprojectBadge";

export function TaskCard({ task }: { task: BoardTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const { openTask } = useTaskModal();
  // Track pointer-down position so a genuine click (no drag movement) opens the
  // task, while a drag does not.
  const start = useRef<{ x: number; y: number } | null>(null);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue =
    due != null && task.status !== "done" && due.getTime() < Date.now();
  const blocked = isBlocked(task.blockedBy);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onPointerDownCapture={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const s = start.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) {
          openTask(task.projectId, task.id);
        }
      }}
      className="cursor-pointer touch-none rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 shadow-sm hover:border-neutral-300 dark:border-neutral-700 active:cursor-grabbing"
    >
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        <span className="text-neutral-400 dark:text-neutral-500">#{task.number}</span>{" "}
        {task.title}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {task.subproject && (
          <SubprojectBadge
            name={task.subproject.name}
            color={task.subproject.color}
          />
        )}
        {blocked && <BlockedBadge />}
        {task.priority && (
          <span
            className={`rounded px-1.5 py-0.5 font-medium capitalize ${PRIORITY_BADGE[task.priority]}`}
          >
            {task.priority}
          </span>
        )}
        {task.assignees.map((a) => (
          <span key={a.id} className="text-neutral-500 dark:text-neutral-400">
            {displayNameOf(a)}
          </span>
        ))}
        {due && (
          <span className={overdue ? "font-medium text-red-600" : "text-neutral-500 dark:text-neutral-400"}>
            {due.toISOString().slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

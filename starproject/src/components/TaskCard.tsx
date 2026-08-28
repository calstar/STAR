"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";

import type { BoardTask } from "@/lib/board";
import { isBlocked } from "@/lib/tasks";

import { BlockedBadge } from "./BlockedBadge";

const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-neutral-100 text-neutral-600",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-red-100 text-red-700",
};

export function TaskCard({ task }: { task: BoardTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

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
      className="cursor-grab touch-none rounded-lg border border-neutral-200 bg-white p-3 shadow-sm active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-neutral-900">{task.title}</p>
        <Link
          href={`/projects/${task.projectId}/tasks/${task.id}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
          title="Open task"
        >
          ↗
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {blocked && <BlockedBadge />}
        {task.priority && (
          <span
            className={`rounded px-1.5 py-0.5 font-medium capitalize ${PRIORITY_BADGE[task.priority]}`}
          >
            {task.priority}
          </span>
        )}
        {task.assignee && (
          <span className="text-neutral-500">
            {task.assignee.name ?? task.assignee.email}
          </span>
        )}
        {due && (
          <span className={overdue ? "font-medium text-red-600" : "text-neutral-500"}>
            {due.toISOString().slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

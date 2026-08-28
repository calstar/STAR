"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { TaskStatus } from "@prisma/client";
import { useEffect, useMemo, useState, useTransition } from "react";

import { moveTask } from "@/lib/actions/tasks";
import {
  type BoardTask,
  type Columns,
  STATUS_COLUMNS,
  groupByStatus,
  midpointOrder,
} from "@/lib/board";

import { Column } from "./Column";
import { TaskCard } from "./TaskCard";

const EMPTY: Columns = { backlog: [], todo: [], in_progress: [], done: [] };

export function Board({ tasks }: { tasks: BoardTask[] }) {
  // Seeded once from props; local state is authoritative while on the board.
  const [cols, setCols] = useState<Columns>(() => groupByStatus(tasks));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync from the server after any mutation revalidates (e.g. a blocker being
  // marked done changes other cards' derived "Blocked" badge). Keyed on a content
  // signature so it only resets when meaningful data actually changed.
  const signature = useMemo(
    () =>
      tasks
        .map(
          (t) =>
            `${t.id}:${t.status}:${t.boardOrder}:${(t.blockedBy ?? [])
              .map((b) => b.blockedByTask.status)
              .join(",")}`,
        )
        .join("|"),
    [tasks],
  );
  useEffect(() => {
    setCols(groupByStatus(tasks));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeTask = useMemo(() => {
    if (!activeId) return null;
    for (const k of Object.keys(cols) as TaskStatus[]) {
      const found = cols[k].find((t) => t.id === activeId);
      if (found) return found;
    }
    return null;
  }, [activeId, cols]);

  function columnOf(id: string): TaskStatus | null {
    if (id.startsWith("col:")) return id.slice(4) as TaskStatus;
    for (const k of Object.keys(cols) as TaskStatus[]) {
      if (cols[k].some((t) => t.id === id)) return k;
    }
    return null;
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const from = columnOf(activeId);
    const to = columnOf(overId);
    if (!from || !to) return;

    const moving = cols[from].find((t) => t.id === activeId);
    if (!moving) return;

    const next: Columns = {
      backlog: [...cols.backlog],
      todo: [...cols.todo],
      in_progress: [...cols.in_progress],
      done: [...cols.done],
    };
    next[from] = next[from].filter((t) => t.id !== activeId);

    let index: number;
    if (overId.startsWith("col:")) {
      index = next[to].length;
    } else {
      index = next[to].findIndex((t) => t.id === overId);
      if (index === -1) index = next[to].length;
    }

    // No-op guard: dropped back exactly where it was.
    if (from === to) {
      const originalIndex = cols[from].findIndex((t) => t.id === activeId);
      if (originalIndex === index) return;
    }

    const updated: BoardTask = { ...moving, status: to };
    next[to] = [
      ...next[to].slice(0, index),
      updated,
      ...next[to].slice(index),
    ];

    const prevOrder = index > 0 ? next[to][index - 1].boardOrder : undefined;
    const nextOrder =
      index < next[to].length - 1 ? next[to][index + 1].boardOrder : undefined;
    const newOrder = midpointOrder(prevOrder, nextOrder);
    updated.boardOrder = newOrder;

    setCols(next);
    startTransition(() => {
      void moveTask(activeId, to, newOrder);
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-3 pb-2">
        {STATUS_COLUMNS.map((c) => (
          <Column
            key={c.key}
            status={c.key}
            label={c.label}
            tasks={(cols ?? EMPTY)[c.key]}
          />
        ))}
      </div>
      <DragOverlay>{activeTask ? <TaskCard task={activeTask} /> : null}</DragOverlay>
    </DndContext>
  );
}

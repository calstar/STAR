"use client";

import { useTaskModal } from "@/components/TaskModalProvider";

/** Opens a task in the in-place modal from server-rendered content (home,
 * activity feed) without a URL change. Renders as a button styled to match its
 * surroundings. */
export function TaskLink({
  projectId,
  taskId,
  className,
  children,
}: {
  projectId: string;
  taskId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { openTask } = useTaskModal();
  return (
    <button
      type="button"
      onClick={() => openTask(projectId, taskId)}
      className={className}
    >
      {children}
    </button>
  );
}

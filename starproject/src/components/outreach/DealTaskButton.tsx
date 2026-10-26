"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { createDealTask } from "@/lib/actions/outreach";

import { BTN_SMALL } from "./ui";

/**
 * "+ Task": file a correspondence task for this sponsor in the task board's
 * Outreach Correspondence project. One open task per sponsor; a second click
 * links the one already there.
 */
export function DealTaskButton({ dealId, className = BTN_SMALL }: { dealId: string; className?: string }) {
  const [pending, start] = useTransition();
  const [task, setTask] = useState<{ id: string; number: number; existed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (task)
    return (
      <Link className={`${className} text-blue-700 dark:text-blue-300`} href={`/tasks?task=${task.id}`} title={task.existed ? "Already on the board" : "Added to Outreach Correspondence"}>
        {task.existed ? "On board" : "Added"} #{task.number} ↗
      </Link>
    );
  return (
    <>
      <button
        className={className}
        disabled={pending}
        title="Add a task for this sponsor to the Outreach Correspondence list"
        onClick={() =>
          start(async () => {
            const r = await createDealTask(dealId);
            if (r.ok) setTask({ id: r.taskId, number: r.number, existed: r.existed });
            else setError(r.error);
          })
        }
      >
        + Task
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </>
  );
}

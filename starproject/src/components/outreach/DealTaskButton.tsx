"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { createDealTask, outreachTaskTargets } from "@/lib/actions/outreach";

import { BTN_SMALL, INPUT } from "./ui";

type Target = { id: string; name: string };
const PROJECT_KEY = "outreach.taskProject";
const SUBTEAM_KEY = "outreach.taskSubteam";

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A convenience only; the picker works without it.
  }
}

/**
 * "+ Task": file a correspondence task for this sponsor in a task-board
 * project. The projects and subteams are the board's own (read when the button
 * is first clicked); the last pick is remembered in this browser. One open task
 * per sponsor per project; a second click links the one already there.
 */
export function DealTaskButton({ dealId, className = BTN_SMALL }: { dealId: string; className?: string }) {
  const [pending, start] = useTransition();
  const [targets, setTargets] = useState<{ projects: Target[]; subteams: Target[] } | null>(null);
  const [projectId, setProjectId] = useState("");
  const [subteamId, setSubteamId] = useState("");
  const [task, setTask] = useState<{ id: string; number: number; existed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (task)
    return (
      <Link
        className={`${className} text-blue-700 dark:text-blue-300`}
        href={`/tasks?task=${task.id}`}
        title={task.existed ? "Already on the board" : "Added to the task board"}
      >
        {task.existed ? "On board" : "Added"} #{task.number} ↗
      </Link>
    );

  const add = () =>
    start(async () => {
      const r = await createDealTask(dealId, { projectId, subteamId: subteamId || null });
      if (!r.ok) return setError(r.error);
      remember(PROJECT_KEY, projectId);
      remember(SUBTEAM_KEY, subteamId);
      setTask({ id: r.taskId, number: r.number, existed: r.existed });
    });

  if (targets)
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <select className={`${INPUT} w-auto py-0.5 text-xs`} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">Project…</option>
          {targets.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className={`${INPUT} w-auto py-0.5 text-xs`} value={subteamId} onChange={(e) => setSubteamId(e.target.value)} aria-label="Subteam">
          <option value="">No subteam</option>
          {targets.subteams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className={className} disabled={pending || !projectId} onClick={add}>
          Add
        </button>
        <button className={className} disabled={pending} onClick={() => setTargets(null)}>
          Cancel
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );

  return (
    <>
      <button
        className={className}
        disabled={pending}
        title="Add a task for this sponsor to the task board"
        onClick={() =>
          start(async () => {
            const r = await outreachTaskTargets();
            if (!r.ok) return setError(r.error);
            const p = remembered(PROJECT_KEY);
            const s = remembered(SUBTEAM_KEY);
            setProjectId(r.projects.some((x) => x.id === p) ? p : "");
            setSubteamId(r.subteams.some((x) => x.id === s) ? s : "");
            setError(null);
            setTargets({ projects: r.projects, subteams: r.subteams });
          })
        }
      >
        + Task
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </>
  );
}

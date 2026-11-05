"use client";

import { useEffect, useState } from "react";

import { EntityRow, LIST_CARD } from "@/components/EntityRow";
import { foldRows } from "@/lib/project-tree";

export type ProjectListRow = {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  taskCount: number;
  depth: number;
};

// Which projects this viewer has opened, per browser. A convenience only: lost
// storage just means every parent starts folded again.
const EXPANDED_KEY = "starproject.projects.expanded";

/**
 * The /projects list as a tree whose parents fold. Parents start folded, so
 * the page opens as the short list of top-level projects and you open the one
 * you're after; what you open is remembered in this browser.
 */
export function ProjectList({ rows }: { rows: ProjectListRow[] }) {
  // Starts all-folded (matching the server-rendered markup) and reads the
  // saved set after mount, so hydration never depends on client-only storage.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
      if (Array.isArray(saved)) setExpanded(new Set(saved.filter((x) => typeof x === "string")));
    } catch {
      // Blocked storage or a bad value: stay folded.
    }
  }, []);

  const save = (next: ReadonlySet<string>) => {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      // Nothing to persist to; the toggle still works for this visit.
    }
  };

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    save(next);
  };

  const shown = foldRows(rows, expanded);
  const parents = foldRows(rows, new Set(rows.map((r) => r.id))).filter((r) => r.below > 0);
  const allOpen = parents.length > 0 && parents.every((p) => expanded.has(p.id));

  return (
    <>
      {parents.length > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => save(allOpen ? new Set() : new Set(parents.map((p) => p.id)))}
            className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      <ul className={`${LIST_CARD} ${parents.length > 0 ? "!mt-2" : ""}`}>
        {rows.length === 0 && (
          <li className="p-4 text-neutral-500 dark:text-neutral-400">
            No projects yet. An admin can create one in Workspace setup.
          </li>
        )}
        {shown.map((r) => {
          const open = expanded.has(r.id);
          return (
            <EntityRow
              key={r.id}
              href={`/projects/${r.id}`}
              color={r.color}
              name={r.name}
              description={r.description}
              taskCount={r.taskCount}
              id={r.id}
              depth={r.depth}
              leading={
                r.below > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggle(r.id)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${r.name}`}
                    className="-m-1 inline-flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                  >
                    <svg
                      aria-hidden
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
                    >
                      <path
                        fillRule="evenodd"
                        d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                ) : r.depth === 0 ? (
                  // Keeps a leaf top-level project's dot in line with its siblings'.
                  <span className="inline-block w-5" aria-hidden />
                ) : undefined
              }
              meta={
                r.below > 0 && !open
                  ? `${r.below} subproject${r.below === 1 ? "" : "s"}`
                  : undefined
              }
            />
          );
        })}
      </ul>
    </>
  );
}

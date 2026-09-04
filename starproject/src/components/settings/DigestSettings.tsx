"use client";

import { useState } from "react";

import {
  setDigestKind,
  toggleDigestProject,
  toggleDigestSubteam,
} from "@/lib/actions/settings";

export function DigestSettings({
  projects,
  subteams,
  followedProjects,
  followedSubteams,
  kinds,
  kindOptions,
}: {
  projects: { id: string; label: string }[];
  subteams: { id: string; name: string }[];
  followedProjects: string[];
  followedSubteams: string[];
  kinds: string[];
  kindOptions: [string, string][];
}) {
  const [projSel, setProjSel] = useState(new Set(followedProjects));
  const [subSel, setSubSel] = useState(new Set(followedSubteams));
  const [kindSel, setKindSel] = useState(new Set(kinds));

  const toggleSet = (
    setState: (fn: (s: Set<string>) => Set<string>) => void,
    id: string,
  ) =>
    setState((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const chip = (active: boolean) =>
    `min-h-11 sm:min-h-0 rounded-full border px-3 sm:px-2.5 py-1 sm:py-0.5 text-sm ${
      active
        ? "border-neutral-900 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Follow projects</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                toggleSet(setProjSel, p.id);
                toggleDigestProject(p.id);
              }}
              className={chip(projSel.has(p.id))}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">Follow subteams</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {subteams.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                toggleSet(setSubSel, s.id);
                toggleDigestSubteam(s.id);
              }}
              className={chip(subSel.has(s.id))}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium">What to include</p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 sm:gap-2">
          {kindOptions.map(([k, label]) => (
            <label key={k} className="flex min-h-11 sm:min-h-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kindSel.has(k)}
                onChange={() => {
                  const next = !kindSel.has(k);
                  toggleSet(setKindSel, k);
                  setDigestKind(k, next);
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        You&apos;ll get one nightly email summarizing the selected activity in the
        projects and subteams you follow.
      </p>
    </div>
  );
}

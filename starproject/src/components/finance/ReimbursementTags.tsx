"use client";

import { useState } from "react";

import { tagReimbursement } from "@/lib/actions/finance";
import type { FinanceDetail } from "@/lib/finance/queries";

export type TagOptions = {
  projects: { id: string; label: string }[];
  subteams: { id: string; name: string }[];
};

const control =
  "min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm sm:min-h-0";

/** The project and subteam a reimbursement is booked to. Saved as soon as one is picked. */
export function ReimbursementTags({
  data,
  options,
  onChanged,
}: {
  data: FinanceDetail;
  options: TagOptions;
  onChanged?: () => void;
}) {
  const [projectId, setProjectId] = useState(data.projectId ?? "");
  const [subteamId, setSubteamId] = useState(data.subteamId ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save(tags: { projectId?: string; subteamId?: string }, undo: () => void) {
    setError(null);
    const res = await tagReimbursement(data.id, tags);
    if ("error" in res) {
      setError(res.error);
      undo();
    } else onChanged?.();
  }

  return (
    <>
      <select
        aria-label="Project"
        className={control}
        value={projectId}
        onChange={(e) => {
          const prev = projectId;
          setProjectId(e.target.value);
          save({ projectId: e.target.value }, () => setProjectId(prev));
        }}
      >
        <option value="">No project</option>
        {/* A tag on an archived project stays selectable. */}
        {data.projectId && !options.projects.some((p) => p.id === data.projectId) && (
          <option value={data.projectId}>{data.projectLabel ?? "Archived project"}</option>
        )}
        {options.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Subteam"
        className={`${control} mt-2`}
        value={subteamId}
        onChange={(e) => {
          const prev = subteamId;
          setSubteamId(e.target.value);
          save({ subteamId: e.target.value }, () => setSubteamId(prev));
        }}
      >
        <option value="">No subteam</option>
        {options.subteams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </>
  );
}

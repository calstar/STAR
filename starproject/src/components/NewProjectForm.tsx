"use client";

import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { createProject } from "@/lib/actions/projects";

// createProject redirects to the new project page, so the form doesn't need to
// reset — navigation replaces it.
export function NewProjectForm({
  parents,
}: {
  parents: { id: string; name: string }[];
}) {
  const [parentId, setParentId] = useState("");
  return (
    <form
      action={createProject}
      className="flex flex-col gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 sm:flex-row sm:flex-wrap sm:items-center [&_button]:min-h-11 sm:[&_button]:min-h-0"
    >
      <input
        name="name"
        required
        placeholder="New project name"
        className="min-h-11 w-full flex-1 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm sm:min-h-0 sm:w-auto sm:min-w-48"
      />
      <input
        name="description"
        placeholder="Description (optional)"
        className="min-h-11 w-full flex-1 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm sm:min-h-0 sm:w-auto sm:min-w-48"
      />
      <FieldSelect
        name="parentId"
        ariaLabel="Parent project"
        value={parentId}
        onChange={setParentId}
        options={[
          { value: "", label: "Top-level project" },
          ...parents.map((p) => ({ value: p.id, label: `Subproject of ${p.name}` })),
        ]}
      />
      <input
        type="color"
        name="color"
        defaultValue="#6366f1"
        aria-label="Project color"
        className="h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 sm:h-9 sm:w-10"
      />
      <button
        type="submit"
        className="inline-flex min-h-11 w-full items-center justify-center rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0 sm:w-auto sm:px-3"
      >
        Create
      </button>
    </form>
  );
}

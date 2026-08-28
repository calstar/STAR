"use client";

import { createProject } from "@/lib/actions/projects";

// createProject redirects to the new project page, so the form doesn't need to
// reset — navigation replaces it.
export function NewProjectForm() {
  return (
    <form
      action={createProject}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white p-3"
    >
      <input
        name="name"
        required
        placeholder="New project name"
        className="min-w-48 flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <input
        name="description"
        placeholder="Description (optional)"
        className="min-w-48 flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <input
        type="color"
        name="color"
        defaultValue="#6366f1"
        aria-label="Project color"
        className="h-9 w-10 rounded border border-neutral-300"
      />
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Create
      </button>
    </form>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { displayNameOf } from "@/lib/names";

const KINDS: [string, string][] = [
  ["created", "Created"],
  ["updated", "Updated"],
  ["deleted", "Deleted"],
  ["blocker_added", "Blocker added"],
  ["blocker_removed", "Blocker removed"],
];

export function ActivityFilters({
  users,
  projects,
  kind,
  actor,
  project,
}: {
  users: {
    id: string;
    name: string | null;
    email: string;
    displayName: string | null;
  }[];
  projects: { id: string; label: string }[];
  kind: string;
  actor: string;
  project: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const p = new URLSearchParams(params.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    p.delete("page"); // any filter change resets to the first page
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <FieldSelect
        ariaLabel="Filter by type"
        value={kind}
        onChange={(v) => set("kind", v)}
        options={[
          { value: "", label: "All types" },
          ...KINDS.map(([v, l]) => ({ value: v, label: l })),
        ]}
      />
      <FieldSelect
        ariaLabel="Filter by person"
        value={actor}
        onChange={(v) => set("actor", v)}
        options={[
          { value: "", label: "All people" },
          ...users.map((u) => ({ value: u.id, label: displayNameOf(u) })),
        ]}
      />
      <FieldSelect
        ariaLabel="Filter by project"
        value={project}
        onChange={(v) => set("project", v)}
        options={[
          { value: "", label: "All projects" },
          ...projects.map((p) => ({ value: p.id, label: p.label })),
        ]}
      />
      {(kind || actor || project) && (
        <button
          onClick={() => router.push(pathname)}
          className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

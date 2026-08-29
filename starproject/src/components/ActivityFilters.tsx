"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

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
  users: { id: string; name: string | null; email: string }[];
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

  const control =
    "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <select value={kind} onChange={(e) => set("kind", e.target.value)} className={control}>
        <option value="">All types</option>
        {KINDS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <select value={actor} onChange={(e) => set("actor", e.target.value)} className={control}>
        <option value="">All people</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name ?? u.email}
          </option>
        ))}
      </select>
      <select value={project} onChange={(e) => set("project", e.target.value)} className={control}>
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
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

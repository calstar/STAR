/** Small chip showing which subproject a task belongs to, used when a parent
 * project aggregates its subprojects' tasks. */
export function SubprojectBadge({
  name,
  color,
}: {
  name: string;
  color: string | null;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color ?? "#a3a3a3" }}
      />
      {name}
    </span>
  );
}

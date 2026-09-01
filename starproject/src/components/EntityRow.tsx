import Link from "next/link";

import { ConfirmButton } from "@/components/ConfirmButton";

/** Shared container for the list-page `<ul>` so projects and subteams match. */
export const LIST_CARD =
  "mt-6 divide-y divide-neutral-200 dark:divide-neutral-800 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900";

/** One row in a list page (projects, subteams). Whole row is a stretched link;
 * the Delete form sits above it and stays clickable. Both list pages use this so
 * they look identical: dot + name on the left, task count + Delete on the right. */
export function EntityRow({
  href,
  color,
  name,
  description,
  taskCount,
  id,
  deleteAction,
  deleteMessage,
  editSlot,
  indent = false,
}: {
  href: string;
  color: string | null;
  name: string;
  description?: string | null;
  taskCount: number;
  id: string;
  /** Passed only when the viewer may delete; omitted hides the button. */
  deleteAction?: (formData: FormData) => void;
  /** Confirmation message shown before the delete runs. */
  deleteMessage?: string;
  /** Optional control (e.g. an Edit button) shown left of Delete, above the link. */
  editSlot?: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <li
      className={`relative flex items-center justify-between hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
        indent ? "py-2.5 pl-10 pr-4" : "p-4"
      }`}
    >
      {/* Overlay link fills the row. Non-interactive content sits *below* it (no
          `relative`) so the link captures clicks and shows the pointer cursor;
          only the Delete button is lifted above with `relative`. */}
      <Link href={href} aria-label={name} className="absolute inset-0" />
      <span className="flex min-w-0 items-center gap-3">
        {indent && <span className="text-neutral-300">↳</span>}
        <span
          className={`inline-block shrink-0 rounded-full ${indent ? "h-2.5 w-2.5" : "h-3 w-3"}`}
          style={{ background: color ?? "#a3a3a3" }}
        />
        <span className={`truncate font-medium ${indent ? "text-sm" : ""}`}>
          {name}
        </span>
        {description && (
          <span className="truncate text-sm text-neutral-500 dark:text-neutral-400">
            {description}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-4">
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {taskCount} task{taskCount === 1 ? "" : "s"}
        </span>
        {editSlot && <span className="relative">{editSlot}</span>}
        {deleteAction && (
          <span className="relative">
            <ConfirmButton
              action={deleteAction}
              id={id}
              className="text-sm text-red-600 hover:underline"
              title={`Delete “${name}”?`}
              message={deleteMessage}
            />
          </span>
        )}
      </span>
    </li>
  );
}

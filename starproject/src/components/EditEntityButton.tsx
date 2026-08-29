"use client";

import { useEffect, useState } from "react";

// An "Edit" button that opens a small dialog to change an entity's name, color,
// and (for projects) description. Submits to a server action. Used in Workspace
// setup for projects and subteams.
export function EditEntityButton({
  action,
  id,
  name,
  color,
  description,
  showDescription = false,
  title = "Edit",
}: {
  action: (formData: FormData) => void | Promise<void>;
  id: string;
  name: string;
  color: string | null;
  description?: string | null;
  showDescription?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const label = "block text-xs font-medium text-neutral-500 dark:text-neutral-400";
  const input =
    "mt-1 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm";

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="text-sm text-neutral-500 hover:text-neutral-800 hover:underline dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        Edit
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <form
            action={action}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 p-5 shadow-xl"
          >
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {title}
            </h2>
            <input type="hidden" name="id" value={id} />

            <div className="mt-4 space-y-3">
              <div>
                <label className={label}>Name</label>
                <input name="name" required defaultValue={name} className={input} />
              </div>
              {showDescription && (
                <div>
                  <label className={label}>Description</label>
                  <input
                    name="description"
                    defaultValue={description ?? ""}
                    placeholder="Optional"
                    className={input}
                  />
                </div>
              )}
              <div>
                <label className={label}>Color</label>
                <input
                  type="color"
                  name="color"
                  defaultValue={color ?? "#6366f1"}
                  className="mt-1 h-9 w-14 rounded border border-neutral-300 dark:border-neutral-700"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                onClick={() => setOpen(false)}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

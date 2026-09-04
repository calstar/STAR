"use client";

import { useEffect, useRef, useState } from "react";

// A destructive-action button that asks "are you sure?" before submitting. It
// drives a hidden <form> bound to a server action, so the actual delete still
// runs server-side. Used for deleting projects, subteams, and tasks.
export function ConfirmButton({
  action,
  id,
  label = "Delete",
  className,
  title = "Are you sure?",
  message,
  confirmLabel = "Delete",
}: {
  action: (formData: FormData) => void | Promise<void>;
  id: string;
  label?: string;
  className?: string;
  title?: string;
  message?: string;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex min-h-11 items-center sm:min-h-0 ${className ?? ""}`}
      >
        {label}
      </button>

      <form ref={formRef} action={action} className="hidden">
        <input type="hidden" name="id" value={id} />
      </form>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-xl bg-white dark:bg-neutral-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {title}
            </h2>
            {message && (
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
                {message}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-11 items-center justify-center rounded border border-neutral-300 px-4 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 sm:min-h-0 sm:px-3"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  formRef.current?.requestSubmit();
                }}
                className="inline-flex min-h-11 items-center justify-center rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 sm:min-h-0 sm:px-3"
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

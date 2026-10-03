"use client";

import { useEffect } from "react";

// The overlay card used for task and reimbursement details: full-screen on phones,
// a centred card from `sm` up. Esc and a backdrop click close it; the page behind
// it doesn't scroll while it's open.
export function Modal({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 sm:p-8"
      onClick={onClose}
    >
      <div
        className="relative flex h-dvh w-full flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-900 shadow-xl sm:h-auto sm:max-h-[85dvh] sm:max-w-3xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          ✕
        </button>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

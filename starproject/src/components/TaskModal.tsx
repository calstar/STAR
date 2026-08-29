"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Wraps intercepted task-detail content as a modal over the board. Backdrop
// click / ✕ / Escape closes it (router.back → returns to the board underneath).
export function TaskModal({
  children,
  closeTo,
}: {
  children: React.ReactNode;
  // Where to go when the modal closes. Given a href, navigate there (works on a
  // fresh reload with no history); otherwise fall back to router.back().
  closeTo?: string;
}) {
  const router = useRouter();
  const close = () => (closeTo ? router.push(closeTo) : router.back());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, closeTo]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={close}
    >
      <div
        className="relative w-full max-w-3xl rounded-xl bg-neutral-50 dark:bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded p-1 text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          ✕
        </button>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

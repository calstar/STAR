"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Wraps intercepted task-detail content as a modal over the board. Backdrop
// click / ✕ / Escape closes it (router.back → returns to the board underneath).
export function TaskModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [router]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={() => router.back()}
    >
      <div
        className="relative w-full max-w-3xl rounded-xl bg-neutral-50 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => router.back()}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
        >
          ✕
        </button>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

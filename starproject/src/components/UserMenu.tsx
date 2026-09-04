"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function UserMenu({
  name,
  email,
  isAdmin = false,
}: {
  name: string;
  email: string;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-h-11 items-center gap-2 rounded-full border border-neutral-300 py-1 pl-1 pr-2.5 text-sm text-neutral-700 hover:bg-neutral-100 sm:min-h-0 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900">
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 shadow-lg">
          <div className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{email}</div>
          <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center rounded px-3 py-2 text-sm text-neutral-700 sm:min-h-0 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Settings
          </Link>
          {isAdmin && (
            <Link
              href="/workspace"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center rounded px-3 py-2 text-sm text-neutral-700 sm:min-h-0 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              Workspace setup
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

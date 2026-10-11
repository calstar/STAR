"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function UserMenu({
  name,
  email,
  isAdmin = false,
  compact = false,
  placement = "down",
}: {
  name: string;
  email: string;
  isAdmin?: boolean;
  /** Avatar only, no name/chevron — for the collapsed sidebar rail. */
  compact?: boolean;
  /**
   * "down" drops the menu below the button (the mobile top bar). "up" opens it
   * above, for the button at the foot of the sidebar: dropping down there put
   * the menu below the bottom of the screen, inside the rail's scroll box, so a
   * click flipped the chevron and showed nothing. "up" renders into <body> at a
   * fixed position so neither that box nor the 68px collapsed rail clips it.
   */
  placement?: "down" | "up";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const up = placement === "up";

  // Close on outside tap and Escape. The "up" menu lives in a portal, so a tap
  // inside it is outside `ref` and has to be checked separately.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Pin the "up" menu to the button. A fixed menu would drift from a button that
  // moves under it, so a resize or a scroll anywhere (the rail scrolls) closes it.
  useLayoutEffect(() => {
    if (!open || !up) return;
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, up]);

  const items = (
    <>
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
    </>
  );
  const panel =
    "w-56 max-w-[calc(100vw-3rem)] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 shadow-lg";

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        className={
          compact
            ? "flex h-9 w-9 items-center justify-center rounded-full border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            : "flex min-h-11 items-center gap-2 rounded-full border border-neutral-300 py-1 pl-1 pr-2.5 text-sm text-neutral-700 hover:bg-neutral-100 sm:min-h-0 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        }
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900">
          {name.charAt(0).toUpperCase()}
        </span>
        {!compact && (
          <>
            <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-4 w-4 text-neutral-400 transition-transform ${open !== up ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </>
        )}
      </button>
      {open && !up && <div className={`absolute right-0 z-50 mt-2 ${panel}`}>{items}</div>}
      {open &&
        up &&
        pos &&
        createPortal(
          <div ref={menuRef} className={`fixed z-50 ${panel}`} style={{ left: pos.left, bottom: pos.bottom }}>
            {items}
          </div>,
          document.body,
        )}
    </div>
  );
}

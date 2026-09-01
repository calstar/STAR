"use client";

import type { User } from "@prisma/client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { updateField } from "@/lib/fieldUpdate";
import { displayNameOf } from "@/lib/names";

/**
 * Multi-assignee picker. A custom dropdown (portal-rendered so table `overflow`
 * can't clip it) whose options toggle on/off — the menu stays open so several
 * people can be picked in one go. A type-ahead box filters long rosters.
 *
 * Two modes:
 *  - inline persist: pass `taskId`; each change is saved via `updateField`
 *    (used by the task table and the detail panel).
 *  - controlled: pass `onChange` (and usually `name`); the parent owns the
 *    value and a hidden input carries the comma-joined ids for native <form>
 *    submission (used by the create form).
 */
export function AssigneeSelect({
  taskId,
  value,
  users,
  onChange,
  name,
}: {
  /** When set, changes persist immediately for this task. */
  taskId?: string;
  /** Currently-selected user ids. */
  value: string[];
  users: User[];
  /** When set, the parent controls `value`; called with the next id list. */
  onChange?: (ids: string[]) => void;
  /** When set, a hidden input carries the ids (comma-joined) for form submit. */
  name?: string;
}) {
  // Controlled by the parent when `onChange` is given; otherwise keep local
  // state (seeded from `value`) so inline edits show immediately.
  const [local, setLocal] = useState<string[]>(value);
  const selected = onChange ? value : local;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selectedSet = new Set(selected);
  const q = query.trim().toLowerCase();
  const visible = q
    ? users.filter((u) => displayNameOf(u).toLowerCase().includes(q))
    : users;

  const label =
    selected.length === 0
      ? "Unassigned"
      : users
          .filter((u) => selectedSet.has(u.id))
          .map((u) => displayNameOf(u))
          .join(", ");

  const commit = (next: string[]) => {
    if (onChange) onChange(next);
    else setLocal(next);
    if (taskId) updateField(taskId, "assigneeIds", next.join(","));
  };

  const toggle = (id: string) => {
    commit(
      selectedSet.has(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  };

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(users.length * 36 + 44 + 8, 300);
    const fitsBelow = window.innerHeight - r.bottom > estH + 8;
    setCoords({
      top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - 4 - estH),
      left: r.left,
      width: r.width,
    });
  }, [users.length]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const openMenu = () => {
    place();
    setQuery("");
    setOpen(true);
  };

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      close();
    };
    const reposition = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, close, place]);

  return (
    <>
      {name && <input type="hidden" name={name} value={selected.join(",")} />}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label="Assignees"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openMenu();
          } else if (e.key === "Escape") {
            close();
          }
        }}
        className={`inline-flex max-w-full items-center gap-1 rounded border border-neutral-300 dark:border-neutral-700 py-1 pl-2 pr-1.5 text-sm cursor-pointer bg-white dark:bg-neutral-900${
          selected.length === 0 ? " text-neutral-500 dark:text-neutral-400" : ""
        }`}
      >
        <span className="truncate">{label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0 opacity-70"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              minWidth: coords.width,
              zIndex: 9999,
            }}
            className="flex max-h-80 flex-col rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg"
          >
            <input
              ref={searchRef}
              type="text"
              aria-label="Search assignees"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                  triggerRef.current?.focus();
                }
              }}
              placeholder="Search…"
              className="m-1 shrink-0 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
            />
            <div
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label="Assignees"
              className="max-h-64 overflow-auto py-1"
            >
              {visible.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-neutral-500 dark:text-neutral-400">
                  No matches
                </div>
              ) : (
                visible.map((u) => {
                  const isSelected = selectedSet.has(u.id);
                  return (
                    <div
                      key={u.id}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => toggle(u.id)}
                      className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800`}
                    >
                      <span className="truncate">{displayNameOf(u)}</span>
                      {isSelected && (
                        <span aria-hidden="true" className="text-xs opacity-70">
                          ✓
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

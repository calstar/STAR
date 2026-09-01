"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type FieldOption = {
  value: string;
  label: string;
  /** Tailwind color classes (e.g. status/priority badge) for this option. */
  badge?: string;
};

/**
 * A custom dropdown that renders its own option list instead of a native
 * <select>. A native <select>'s open menu is drawn by the OS — on macOS that
 * means author `background-color` on <option>s is ignored, so our status /
 * priority colors never showed when the menu was open. Rendering the list
 * ourselves (in a portal, so table `overflow` can't clip it) keeps the colors
 * identical on every platform, and keeps it keyboard- and screen-reader-usable.
 *
 * `searchable` adds a filter box at the top of the open list — handy for long
 * lists like the assignee picker.
 */
export function FieldSelect({
  value,
  onChange,
  options,
  ariaLabel,
  name,
  placeholder,
  disabled = false,
  searchable = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FieldOption[];
  ariaLabel: string;
  /** When set, a hidden input carries the value so a native <form> submits it. */
  name?: string;
  /** Trigger text shown when `value` matches no option (nothing selected yet). */
  placeholder?: string;
  disabled?: boolean;
  /** Show a filter box at the top of the list to type-ahead search options. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
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

  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const visible =
    searchable && q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;

  // Position the portal popup against the trigger, flipping above it when
  // there isn't room below (viewport coords → `position: fixed`).
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(options.length * 36 + (searchable ? 44 : 0) + 8, 300);
    const fitsBelow = window.innerHeight - r.bottom > estH + 8;
    setCoords({
      top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - 4 - estH),
      left: r.left,
      width: r.width,
    });
  }, [options.length, searchable]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const openMenu = () => {
    if (disabled) return;
    place();
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const choose = (v: string) => {
    onChange(v);
    close();
    triggerRef.current?.focus();
  };

  // Focus the search box when a searchable menu opens.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  // Keep the active option scrolled into view as it changes.
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-opt-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      close();
    };
    const reposition = () => place();
    document.addEventListener("mousedown", onDown);
    // Reposition on scroll (capture — catches scrolling ancestors too) so the
    // menu tracks the trigger; resize likewise.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, close, place]);

  // Shared arrow/Enter/Escape handling over the currently-visible options.
  const handleNav = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(visible.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(visible.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (visible[active]) choose(visible[active].value);
        break;
      case "Tab":
        close();
        break;
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (searchable) return; // focus lives in the search box while open
    if (e.key === " ") {
      e.preventDefault();
      if (visible[active]) choose(visible[active].value);
      return;
    }
    handleNav(e);
  };

  const activeId = open ? `${listId}-opt-${active}` : undefined;

  return (
    <>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex max-w-full items-center gap-1 rounded border border-neutral-300 dark:border-neutral-700 py-1 pl-2 pr-1.5 text-sm ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        } ${
          selected?.badge
            ? `font-medium ${selected.badge}`
            : `bg-white dark:bg-neutral-900${
                selected ? "" : " text-neutral-500 dark:text-neutral-400"
              }`
        }`}
      >
        <span className="truncate">{selected?.label ?? placeholder ?? ""}</span>
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
            {searchable && (
              <input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label={`Search ${ariaLabel}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={handleNav}
                placeholder="Search…"
                className="m-1 shrink-0 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
              />
            )}
            <div
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="max-h-64 overflow-auto py-1"
            >
              {visible.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-neutral-500 dark:text-neutral-400">
                  No matches
                </div>
              ) : (
                visible.map((o, i) => {
                  const isSelected = o.value === value;
                  const isActive = i === active;
                  return (
                    <div
                      key={o.value}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(o.value)}
                      className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-sm ${
                        o.badge
                          ? `font-medium ${o.badge} ${
                              isActive ? "ring-2 ring-inset ring-black/10 dark:ring-white/25" : ""
                            }`
                          : `text-neutral-700 dark:text-neutral-200 ${
                              isActive ? "bg-neutral-100 dark:bg-neutral-800" : ""
                            }`
                      }`}
                    >
                      <span className="truncate">{o.label}</span>
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

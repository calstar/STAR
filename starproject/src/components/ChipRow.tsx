"use client";

import { useState } from "react";

// Filter chips, as the Tasks page's Projects / Subteams rows and the Purchase
// Requests page's Status / Projects rows show them.

/** A filter chip, on (dark) or off (outlined). */
export const chipClass = (active: boolean) =>
  `min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 py-0.5 text-sm sm:min-h-0 sm:shrink sm:px-2.5 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
  }`;

// How many filter chips a row shows before collapsing behind "+N more".
const CHIP_LIMIT = 8;

// A capped filter-chip row: shows the first CHIP_LIMIT options (plus any
// selected ones beyond the cap, so an active filter is never hidden) with a
// "+N more" chip to expand. Collapsed on mobile it stays a single
// horizontally-scrollable line; expanded it wraps at every width.
export function ChipRow({
  label,
  options,
  selected,
  onToggle,
  chip = chipClass,
}: {
  label: string;
  options: { id: string; label: string; color?: string | null; title?: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  chip?: (active: boolean) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  // No point hiding a single option behind a "+1 more" chip of the same size.
  const collapsible = options.length > CHIP_LIMIT + 1;
  const visible =
    expanded || !collapsible
      ? options
      : [
          ...options.slice(0, CHIP_LIMIT),
          ...options.slice(CHIP_LIMIT).filter((o) => selected.has(o.id)),
        ];
  const hiddenCount = options.length - visible.length;

  // The label sits outside the scroll container so it stays pinned on the
  // left while the chips carousel past it on mobile.
  return (
    <div className={`flex gap-1.5 ${expanded ? "items-start" : "items-center"}`}>
      <span
        className={`shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400 ${
          expanded ? "py-2.5 sm:py-1" : ""
        }`}
      >
        {label}
      </span>
      <div
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${
          expanded
            ? "flex-wrap"
            : "flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-x-visible"
        }`}
      >
        {visible.map((o) => (
          <button
            key={o.id}
            onClick={() => onToggle(o.id)}
            title={o.title}
            className={`${chip(selected.has(o.id))} ${o.color !== undefined ? "inline-flex items-center gap-1.5" : ""}`}
          >
            {o.color !== undefined && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: o.color ?? "#a3a3a3" }}
              />
            )}
            {o.label}
          </button>
        ))}
        {collapsible && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`${chip(false)} font-medium`}
          >
            {expanded ? "Show less" : `+${hiddenCount} more`}
          </button>
        )}
      </div>
    </div>
  );
}


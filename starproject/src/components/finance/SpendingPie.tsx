"use client";

import { useState } from "react";

import type { PieSlice } from "@/lib/finance/charts";
import { formatCents } from "@/lib/finance/money";

const fill = (c: PieSlice["color"]) => (typeof c === "number" ? `var(--viz-${c + 1})` : `var(--viz-${c})`);

const R = 64; // outer radius
const r = 42; // inner radius
const C = 70; // centre (the viewBox is 140 square)

/** A ring segment from angle a0 to a1 (radians, clockwise from twelve o'clock). */
function arc(a0: number, a1: number): string {
  const pt = (rad: number, a: number) => `${C + rad * Math.sin(a)} ${C - rad * Math.cos(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
}

/** A donut of one breakdown with its legend; hovering either names the slice in the middle. */
export function SpendingPie({ label, slices }: { label: string; slices: PieSlice[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((s, x) => s + x.cents, 0);
  if (total === 0) return null;
  const pct = (c: number) => `${Math.round((c / total) * 100)}%`;
  const active = slices.find((s) => s.key === hover);

  let a = 0;
  const arcs = slices.map((s) => {
    const a0 = a;
    a += (s.cents / total) * 2 * Math.PI;
    return { s, a0, a1: a };
  });

  return (
    <div className="viz mt-3 flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0" role="img" aria-label={`${label}: ${slices.map((s) => `${s.name} ${pct(s.cents)}`).join(", ")}`}>
        {arcs.length === 1 ? (
          <circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke={fill(arcs[0].s.color)} strokeWidth={R - r} />
        ) : (
          arcs.map(({ s, a0, a1 }) => (
            <path
              key={s.key}
              d={arc(a0, a1)}
              fill={fill(s.color)}
              stroke="var(--viz-surface)"
              strokeWidth={2}
              strokeLinejoin="round"
              opacity={hover && hover !== s.key ? 0.35 : 1}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
            />
          ))
        )}
        <text x={C} y={C - 4} textAnchor="middle" className="fill-neutral-500 text-[9px] dark:fill-neutral-400">
          {active ? (active.name.length > 16 ? `${active.name.slice(0, 15)}…` : active.name) : "Total"}
        </text>
        <text x={C} y={C + 11} textAnchor="middle" className="fill-neutral-900 text-[13px] font-semibold tabular-nums dark:fill-neutral-100">
          {formatCents(active ? active.cents : total).replace(/\.\d\d$/, "")}
        </text>
      </svg>
      <ul className="min-w-56 flex-1 space-y-1 text-sm">
        {slices.map((s) => (
          <li
            key={s.key}
            className={`flex items-center gap-2 rounded px-1 ${hover === s.key ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: fill(s.color) }} />
            <span className={`min-w-0 flex-1 truncate ${s.color === "untagged" ? "italic text-neutral-500" : ""}`}>{s.name}</span>
            <span className="tabular-nums">{formatCents(s.cents)}</span>
            <span className="w-9 text-right text-xs text-neutral-500 tabular-nums dark:text-neutral-400">{pct(s.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

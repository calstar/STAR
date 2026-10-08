"use client";

import { useState } from "react";

import { compactDollars, niceAxis } from "@/lib/finance/charts";
import { SCHOOL_MONTHS, type Bucket } from "@/lib/finance/ledger";
import { formatCents } from "@/lib/finance/money";

const HEIGHT = 160; // px of plot

/** The school year's spending month by month, approved below pending; the biggest month is labelled. */
export function MonthlySpending({ months }: { months: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const size = (b: Bucket) => b.paidCents + b.pendingCents;
  const max = Math.max(...months.map(size));
  const { top, step } = niceAxis(max);
  const peak = max > 0 ? months.findIndex((b) => size(b) === max) : -1;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const px = (c: number) => (c / top) * HEIGHT;

  return (
    <div className="viz">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">By month</h3>
        <p className="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--viz-approved)" }} /> Approved
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--viz-pending)" }} /> Pending
          </span>
        </p>
      </div>

      <div className="mt-5 flex gap-2">
        {/* y axis */}
        <div className="relative w-9 shrink-0 text-right text-[10px] text-neutral-500 tabular-nums dark:text-neutral-400" style={{ height: HEIGHT }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: px(t) }}>
              {compactDollars(t)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: HEIGHT }}>
            {ticks.map((t) => (
              <div key={t} className="absolute inset-x-0 h-px" style={{ bottom: px(t), background: "var(--viz-grid)" }} />
            ))}
            <div className="absolute inset-0 grid grid-cols-12 grid-rows-[100%]">
              {months.map((b, i) => {
                const paid = px(b.paidCents);
                const pending = px(b.pendingCents);
                return (
                  <div
                    key={i}
                    className={`relative flex h-full flex-col items-center justify-end ${hover === i ? "bg-neutral-100/70 dark:bg-neutral-800/50" : ""}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    aria-label={`${SCHOOL_MONTHS[i]}: ${formatCents(size(b))}`}
                  >
                    {i === peak && hover === null && (
                      <span
                        className="absolute whitespace-nowrap text-[10px] leading-none font-medium text-neutral-700 tabular-nums dark:text-neutral-200"
                        style={{ bottom: paid + pending + (paid && pending ? 2 : 0) + 4 }}
                      >
                        {compactDollars(size(b))}
                      </span>
                    )}
                    {pending > 0 && (
                      <span
                        className="w-full max-w-6 rounded-t-[4px]"
                        style={{ height: pending, background: "var(--viz-pending)", marginBottom: paid > 0 ? 2 : 0 }}
                      />
                    )}
                    {paid > 0 && (
                      <span
                        className={`w-full max-w-6 ${pending > 0 ? "" : "rounded-t-[4px]"}`}
                        style={{ height: paid, background: "var(--viz-approved)" }}
                      />
                    )}
                    {hover === i && (
                      <div
                        className={`pointer-events-none absolute z-10 w-max rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-neutral-700 dark:bg-neutral-900 ${
                          i > 8 ? "right-0" : i < 3 ? "left-0" : "left-1/2 -translate-x-1/2"
                        }`}
                        style={{ bottom: Math.min(paid + pending + 8, HEIGHT - 60) }}
                      >
                        <p className="font-medium">{SCHOOL_MONTHS[i]}</p>
                        <p className="tabular-nums">{formatCents(size(b))} spent</p>
                        {b.pendingCents > 0 && <p className="text-neutral-500 tabular-nums dark:text-neutral-400">{formatCents(b.pendingCents)} pending</p>}
                        <p className="text-neutral-500 dark:text-neutral-400">
                          {b.count} request{b.count === 1 ? "" : "s"}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1 grid grid-cols-12 text-center text-[10px] text-neutral-500 dark:text-neutral-400">
            {SCHOOL_MONTHS.map((m, i) => (
              <span key={m} className={i % 2 ? "invisible sm:visible" : ""}>
                {m}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

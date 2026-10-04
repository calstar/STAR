import React from 'react';
import { Info } from '../Hint';

export const STABLE = '#22c55e';
export const UNSTABLE = '#ef4444';
export const MARGINAL = '#f59e0b';
export const DESIGN = '#38bdf8';
export const MUTED = '#64748b';

/** One chart card: title, a one-line subtitle, the chart, and its explanation behind an ⓘ. */
export function VizCard({
  title,
  subtitle,
  info,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  /** How to read the card and where its numbers come from: shown on hover, not on the page. */
  info?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
        {info && <Info text={<span className="block max-w-72 space-y-1.5">{info}</span>} />}
      </div>
      {subtitle && (
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-3">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}
      {children}
    </div>
  );
}

/** Recharts margin — bottom leaves room for axis titles. */
export const CHART_MARGIN = { top: 12, right: 16, left: 8, bottom: 28 };

export function marginColor(margin: number, threshold = 1.05): string {
  if (!Number.isFinite(margin)) return MUTED;
  if (margin >= threshold) return STABLE;
  if (margin >= threshold * 0.9) return MARGINAL;
  return UNSTABLE;
}

import React from 'react';

export const STABLE = '#22c55e';
export const UNSTABLE = '#ef4444';
export const MARGINAL = '#f59e0b';
export const DESIGN = '#38bdf8';
export const MUTED = '#64748b';

export function VizCard({
  title,
  subtitle,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${className}`}
    >
      <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
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

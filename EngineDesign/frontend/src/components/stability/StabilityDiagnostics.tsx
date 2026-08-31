import { useState } from 'react';
import type { StabilityRichPayload } from './types';
import { STABLE, UNSTABLE, MARGINAL, MUTED } from './shared';

const STATE_COLOR: Record<string, string> = {
  stable: STABLE,
  marginal: MARGINAL,
  unstable: UNSTABLE,
};

const SEV_COLOR: Record<string, string> = {
  critical: UNSTABLE,
  warn: MARGINAL,
  ok: STABLE,
};

/**
 * Diagnostics-first header for the combustion-stability panel: a plain-language verdict,
 * the findings behind it, and the design levers that move each one. Derived server-side from
 * the same numbers the cards below render (plan §C).
 */
export function StabilityDiagnostics({ data }: { data: StabilityRichPayload }) {
  const [showAssumptions, setShowAssumptions] = useState(false);
  const d = data.diagnostics;
  if (!d) return null;

  const stateColor = STATE_COLOR[d.state] ?? MUTED;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Headline verdict */}
      <div className="flex items-start gap-3 p-4 border-b border-[var(--color-border)]">
        <span
          className="mt-1.5 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: stateColor }}
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: stateColor }}>
            {d.headline}
          </p>
          {(d.limiting_mode || d.driver) && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {d.limiting_mode && (
                <>
                  Limiting mode: <span className="text-[var(--color-text-primary)]">{d.limiting_mode}</span>
                </>
              )}
              {d.driver && (
                <>
                  {' · '}driver: <span className="text-[var(--color-text-primary)]">{d.driver}</span>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[var(--color-border)]">
        {/* What's limiting you */}
        <div className="bg-[var(--color-bg-secondary)] p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">
            What&apos;s limiting you
          </h4>
          <ul className="space-y-2">
            {d.findings.map((f, i) => (
              <li key={i} className="flex gap-2 text-xs text-[var(--color-text-primary)]">
                <span
                  className="mt-1 inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: SEV_COLOR[f.severity] ?? MUTED }}
                />
                <span className="leading-snug">{f.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* What you can do */}
        <div className="bg-[var(--color-bg-secondary)] p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">
            What you can do
          </h4>
          {d.actions.length === 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)]">
              No design changes needed - keep monitoring during hot fire.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {d.actions.map((a, i) => (
                <li key={i} className="text-xs">
                  <div className="flex items-start gap-2">
                    <span className="text-[var(--color-text-primary)] leading-snug">{a.text}</span>
                    {a.lever && (
                      <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                        {a.lever}
                      </span>
                    )}
                  </div>
                  <p className="text-[var(--color-text-secondary)] mt-0.5 leading-snug opacity-90">
                    {a.rationale}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Assumptions in play */}
      <button
        type="button"
        onClick={() => setShowAssumptions((s) => !s)}
        className="w-full flex items-center justify-between px-4 py-2 text-[11px] text-[var(--color-text-secondary)] border-t border-[var(--color-border)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <span>Assumptions in play</span>
        <span className="font-mono">{showAssumptions ? '−' : '+'}</span>
      </button>
      {showAssumptions && (
        <p className="px-4 pb-3 text-[11px] text-[var(--color-text-secondary)] leading-snug">
          {d.assumptions_note}
        </p>
      )}
    </div>
  );
}

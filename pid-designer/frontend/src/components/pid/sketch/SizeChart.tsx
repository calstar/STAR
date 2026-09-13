/**
 * The size chart: what a nominal size means as a bore, at a glance.
 *
 * Four nominal sizes down the side; across, what each is in the three
 * families the team buys -- NPT, JIC/AN, and tube by OD × wall -- with the
 * inner diameter as the number you came for. Designed like a reference card:
 * the nominal is the row, the ID is the big figure, the source the small one,
 * and what mates with what is a bracket rather than a sentence.
 *
 * What is stated here, and what is not: a dash size *is* a tube OD in
 * sixteenths (SAE J514), and a tube's ID is its OD less two walls --
 * arithmetic, exact for whatever wall you pick. What is *not* stated is an
 * NPT fitting's bore, because there is no standard one: it is the part's,
 * and comes off the part's page. Nothing here is typed from memory.
 */

import { useState } from 'react';
import type { Unit } from './model';

const NOMINALS = ['1/8', '1/4', '3/8', '1/2'] as const;

/** Dash = OD in sixteenths of an inch (SAE J514). */
const DASH: Record<(typeof NOMINALS)[number], number> = { '1/8': 2, '1/4': 4, '3/8': 6, '1/2': 8 };

/**
 * Tube walls the card offers, inches. These are the walls stocked for
 * fractional stainless and aluminium tube; the card marks every wall as one
 * to match against the supplier's page for the OD in hand, because a wall
 * that is not stocked at that OD is not a tube you can buy.
 */
const WALLS_IN = [0.028, 0.035, 0.049, 0.065];

const inMm = (x: number) => x * 25.4;
const frac = (n: (typeof NOMINALS)[number]) => ({ '1/8': 0.125, '1/4': 0.25, '3/8': 0.375, '1/2': 0.5 })[n];

export function SizeChart({ unit, readOnly, onPick }: {
  unit: Unit;
  readOnly: boolean;
  /** Bore chosen, in mm, and what it came from. */
  onPick: (boreMm: number, reference: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const show = (mm: number) => unit === 'in' ? `${(mm / 25.4).toFixed(3)}″` : unit === 'm' ? `${(mm / 1000).toFixed(4)} m` : `${mm.toFixed(2)} mm`;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[10px]">
      <button onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
        <span>Sizes · what a nominal is as a bore</span><span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="overflow-x-auto px-2 pb-2">
          <table className="w-full border-collapse font-mono">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="py-1 text-left font-normal">nominal</th>
                <th className="py-1 text-left font-normal">NPT</th>
                <th className="py-1 text-left font-normal">JIC / AN</th>
                <th className="py-1 text-left font-normal" colSpan={WALLS_IN.length}>tube OD × wall → ID</th>
              </tr>
              <tr className="text-[9px] text-[var(--color-text-muted)]">
                <th /><th /><th />
                {WALLS_IN.map(w => <th key={w} className="pb-1 text-left font-normal">× {w.toFixed(3)}″</th>)}
              </tr>
            </thead>
            <tbody>
              {NOMINALS.map(n => {
                const od = frac(n);
                return (
                  <tr key={n} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1.5 pr-2 text-[13px] font-semibold text-[var(--color-text-primary)]">{n}″</td>
                    <td className="py-1.5 pr-2 text-[var(--color-text-secondary)]">
                      {n} NPT<br />
                      <span className="text-[var(--color-text-muted)]">bore is the fitting's — from its page</span>
                    </td>
                    <td className="py-1.5 pr-2 text-[var(--color-text-secondary)]">
                      -{DASH[n]}<br />
                      <span className="text-[var(--color-text-muted)]">mates {n}″ OD tube (SAE J514)</span>
                    </td>
                    {WALLS_IN.map(w => {
                      const idIn = od - 2 * w;
                      if (idIn <= 0.02) return <td key={w} className="py-1.5 pr-2 text-[var(--color-text-muted)]">—</td>;
                      const mm = inMm(idIn);
                      const ref = `${n}″ OD × ${w.toFixed(3)}″ wall tube: ID = OD − 2·wall = ${idIn.toFixed(3)}″ — check the wall is stocked at this OD`;
                      return (
                        <td key={w} className="py-1.5 pr-2">
                          <button disabled={readOnly} onClick={() => onPick(mm, ref)} title={ref}
                            className="rounded px-1 text-[12px] text-[var(--color-text-primary)] underline decoration-dotted hover:bg-[var(--color-bg-tertiary)]">
                            {show(mm)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="pt-1 text-[9px] text-[var(--color-text-muted)]">
            Click an ID to use it. Tube IDs are OD − 2·wall, exact; whether that wall is stocked at that OD is the supplier's page. NPT bores vary by maker and are not stated here.
          </p>
        </div>
      )}
    </div>
  );
}

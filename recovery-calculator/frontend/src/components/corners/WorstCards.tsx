/**
 * The governing corner for each failure category, and that category's spread.
 *
 * Three cards, not one headline. §11.5 establishes that each case fails in a
 * different category and no single number covers them; across the corners it
 * is sharper still, because for the worked vehicle the structural worst case
 * is the AXIAL airframe bound and the drift worst case is BROADSIDE -- the
 * opposite corner. A single "worst case" would state the airframe is nose-down
 * while the descent-time risk lives at the other bound.
 *
 * Each card carries its own range rather than there being one shared spread
 * panel: the three categories are measured in newtons, seconds and joules, so
 * a combined summary was three unrelated numbers in a row, and the range only
 * means anything beside the worst case it bounds.
 *
 * Cards are tinted with the colour their corner is drawn in on the chart, so
 * "which line is the structural worst case" is answered by looking, not by
 * matching a parameter list against a legend.
 */

import type { SweepCorner, SweepResult, SweepWorst } from '../../api/client'
import { Card } from '../ui'
import { colourFor } from '../chartTheme'
import { candidateLabel, cornerValue, keyMeta, orderedKeys } from '../../lib/corners'
import type { Kind } from '../../lib/quantities'
import { useUnits } from '../../lib/unitsContext'
import type { Units } from '../../lib/unitsContext'

type CategoryKey = 'structure' | 'drift' | 'impact'

/**
 * How each category is measured, and out of which field.
 *
 * `of` reads the UNFACTORED peak for structure, not F_design. The safety
 * factor is the same in every corner, so the two rank identically and the
 * sweep's answer is unchanged -- but the peak is the load the hardware
 * actually sees, and so the number to compare a component rating against.
 */
const CATEGORIES: {
  key: CategoryKey
  label: string
  why: string
  /** The quantity, when the unit is user-selectable. Drift has none: it is
   *  seconds, and seconds have no imperial form. */
  kind?: Kind
  /** Only for the kinds without a `kind`. */
  unit?: string
  of: (row: SweepCorner) => number
  /** Only for the categories without a `kind`. Takes the context's `dec` so
   *  the global precision bounds apply here too. */
  fmt?: (v: number, dec: Units['dec']) => string
}[] = [
  {
    key: 'structure',
    label: 'Structure',
    why: 'Highest peak load — what the hardware must survive.',
    kind: 'force',
    of: (r) => r.F_peak ?? 0,
  },
  {
    key: 'drift',
    label: 'Drift',
    why: 'Longest descent — furthest downwind.',
    unit: 's',
    of: (r) => r.descent_time,
    fmt: (v, dec) => dec(v, 1),
  },
  {
    key: 'impact',
    label: 'Impact',
    why: 'Most kinetic energy at the ground.',
    kind: 'energy',
    of: (r) => r.impact_ke,
  },
]

/**
 * The parameter values that produced this worst case.
 *
 * Named, not just symbolled. `Cx1.8 n6 axial Δt0` is the legend form, which is
 * fine next to a line but says nothing on its own -- a reader seeing it here
 * cannot tell whether it describes the cause or some property of the result.
 * Each chip is a name over a BARE value, with the full explanation on hover;
 * the label already says "Cx", so the value is `1.8`, not `Cx1.8`.
 *
 * Parameters that did not move THIS metric are struck out. Without that,
 * `max()` ties read as significant: the peak load is identical at v_rel 5 and
 * 20 whenever the infinite-mass bound governs, so naming one of them invites
 * "v_rel = 5 is the dangerous case", which is backwards. The CLI draws the
 * same distinction in `report._corner_str`.
 */
function CornerChips({ worst }: { worst: SweepWorst }) {
  const { num, lab } = useUnits()
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {orderedKeys(worst.corner).map((k) => {
        const dead = worst.irrelevant.includes(k)
        const meta = keyMeta(k)
        return (
          <span
            key={k}
            title={dead
              ? `${meta.help}\n\nThis metric is identical at both bounds of this parameter, so the value shown is whichever the tie-break landed on — the other bound gives the same answer.`
              : meta.help}
            className={`rounded border px-2 py-1 leading-tight ${
              dead
                ? 'border-dashed border-[var(--color-border)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
            }`}
          >
            <span className="block text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
              {meta.name}
              {/* NOT a strikethrough on the value. The value is real -- this
                  run genuinely had Cx = 1.2 -- it simply did not cause the
                  worst case, because the metric is the same at either bound.
                  Striking it out says "not 1.2", which is false. */}
              {dead && <span className="normal-case italic"> · no effect</span>}
            </span>
            <span className={`block text-xs ${
              dead ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-primary)]'
            }`}>
              {cornerValue(k, worst.corner[k], worst.attitude, num)}
              {meta.kind ? ` ${lab(meta.kind)}` : meta.unit && ` ${meta.unit}`}
            </span>
          </span>
        )
      })}
    </div>
  )
}

export function WorstCards({ result, selectedIds, onSelect }: {
  result: SweepResult
  selectedIds: string[]
  onSelect: (id: string) => void
}) {
  const { num, lab, dec } = useUnits()
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {CATEGORIES.map((cat) => {
        const w = result.worst_by_category[cat.key]
        if (!w) return null

        // One formatter per category, so the headline, the range and the
        // nominal figure cannot disagree about precision or unit.
        const show = (v: number) =>
          cat.kind ? num(v, cat.kind) : (cat.fmt ?? String)(v, dec)
        const unit = cat.kind ? lab(cat.kind) : cat.unit ?? ''

        const values = result.corners.map(cat.of)
        const lo = Math.min(...values)
        const hi = Math.max(...values)
        const nominal = cat.key === 'structure'
          ? (result.nominal.F_peak ?? 0)
          : cat.key === 'drift' ? result.nominal.descent_time
          : result.nominal.impact_ke

        // The card wears its line's colour -- but only while that line is on
        // the chart. Tinting a header to match a line that is not drawn would
        // point at nothing.
        const shown = selectedIds.includes(w.id)
        const colour = shown ? colourFor(selectedIds, w.id) : undefined

        return (
          <Card
            key={cat.key}
            title={
              <span className="flex items-center gap-2">
                {/* Not colour alone: the swatch sits beside a word, and the
                    same colour carries the same corner in the legend and in
                    the table's swatch. */}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border"
                  style={{
                    backgroundColor: colour ?? 'transparent',
                    borderColor: colour ?? 'var(--color-text-muted)',
                  }}
                />
                <span style={colour ? { color: colour } : undefined}>{cat.label}</span>
              </span>
            }
            subtitle={cat.why}
            right={
              <button
                type="button"
                onClick={() => onSelect(w.id)}
                className={`rounded border px-2 py-1 text-2xs transition-colors ${
                  shown
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]'
                }`}
                title={shown ? 'Hide this corner on the chart' : 'Plot this corner'}
              >
                {shown ? 'on chart' : 'plot'}
              </button>
            }
          >
            <div className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
              worst of {result.runs} corners
            </div>
            <div className="text-lg text-[var(--color-text-primary)]">
              {show(hi)}
              <span className="ml-1 text-xs text-[var(--color-text-secondary)]">
                {unit}
              </span>
            </div>

            {/* The spread is the actual product of a sweep. A worst case with
                no range beside it reads as a fact about the vehicle rather
                than as the top of a band that is 3x wide. */}
            <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <span className="text-[var(--color-text-muted)]">
                range{' '}
                <span className="text-[var(--color-text-secondary)]">
                  {show(lo)} – {show(hi)} {unit}
                </span>
                {/* Spell out what the ratio divides. A bare "2.70x" beside two
                    numbers invites reading it as a factor on one of them. */}
                {lo > 0 && (
                  <span
                    className="ml-1.5 text-amber-400"
                    title={`The worst corner is ${dec(hi / lo, 2)} times the best. That spread is what is unknown about this vehicle, not a margin.`}
                  >
                    {dec(hi / lo, 2)}× worst/best
                  </span>
                )}
              </span>
              <span className="text-[var(--color-text-muted)]">
                nominal{' '}
                <span className="text-[var(--color-text-secondary)]">
                  {show(nominal)} {unit}
                </span>
              </span>
            </div>

            <p className="mt-3 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
              worst when
            </p>
            <CornerChips worst={w} />

            {/* What sets the peak IN THE WORST CORNER -- not a census of all
                32. The peak is a max over competing candidates (each device's
                canopy-opening bound, each device's line-stretch snatch, the
                integrated trajectory peak), and the only one worth naming is
                the one that wins where you are designing to. How often the
                others win elsewhere does not change what to strengthen. */}
            {cat.key === 'structure' && w.governing_device && (
              <p className="mt-3 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-muted)]">
                set by{' '}
                <span className="text-[var(--color-text-primary)]">
                  {candidateLabel(`${w.governing_device} / ${w.governing_candidate}`).device}{' '}
                  {candidateLabel(`${w.governing_device} / ${w.governing_candidate}`).what}
                </span>
              </p>
            )}
          </Card>
        )
      })}
    </div>
  )
}

/**
 * Every corner, and the control for what the chart draws.
 *
 * Selection lives in this table rather than in a separate chip row, because a
 * second list of the same 32 things is a second place for them to disagree.
 * Sorted by design load descending, so the governing corner is the first row.
 */

import type { SweepCorner, SweepResult } from '../../api/client'
import { Badge, Card, Toggle } from '../ui'
import { candidateLabel, cornerValue, keyMeta, orderedKeys } from '../../lib/corners'
import { useUnits } from '../../lib/unitsContext'
import { MAX_SELECTED, colourFor } from '../chartTheme'

/** Which categories each corner is the worst for, so the rows that matter are
 *  findable without cross-referencing the cards above. */
function badgesFor(result: SweepResult, id: string): string[] {
  return Object.entries(result.worst_by_category)
    .filter(([, w]) => w.id === id)
    .map(([name]) => name)
}

export function CornerTable({ result, selectedIds, onToggle, showContext, onShowContext }: {
  result: SweepResult
  selectedIds: string[]
  onToggle: (id: string) => void
  showContext: boolean
  onShowContext: (v: boolean) => void
}) {
  const { num, q, dec, lab } = useUnits()
  const rows = [...result.corners].sort(
    (a, b) => (b.F_peak ?? 0) - (a.F_peak ?? 0))
  const full = selectedIds.length >= MAX_SELECTED
  const keys = rows.length ? orderedKeys(rows[0].corner) : []

  return (
    <Card
      title={`Corners (${result.runs})`}
      subtitle="Sorted by peak load. Tick a row to plot it."
      right={
        <div className="flex items-center gap-3">
          <Toggle
            checked={showContext}
            onChange={onShowContext}
            label="show the rest as context"
          />
          <Badge tone={full ? 'warning' : 'neutral'}>
            {selectedIds.length}/{MAX_SELECTED} plotted
          </Badge>
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="w-10 py-1.5 pr-2 font-medium" />
              {keys.map((k) => {
                const meta = keyMeta(k)
                return (
                  <th key={k} className="py-1.5 pr-3 font-medium" title={meta.help}>
                    {meta.name}
                    {meta.kind ? ` (${lab(meta.kind)})` : meta.unit && ` (${meta.unit})`}
                  </th>
                )
              })}
              <th className="py-1.5 pr-3 text-right font-medium"
                  title="The maximum load before the safety factor - the load the hardware actually sees.">
                peak load
              </th>
              <th className="py-1.5 pr-3 text-right font-medium">descent</th>
              <th className="py-1.5 pr-3 text-right font-medium">impact KE</th>
              <th className="py-1.5 font-medium">governed by</th>
            </tr>
          </thead>
          <tbody className="text-[var(--color-text-secondary)]">
            {rows.map((row: SweepCorner) => {
              const on = selectedIds.includes(row.id)
              const marks = badgesFor(result, row.id)
              // A full palette blocks NEW selections but never blocks turning
              // one off -- otherwise the sixth tick traps you.
              const blocked = !on && full
              return (
                <tr
                  key={row.id}
                  className={`border-b border-[var(--color-border)]/50 ${
                    on ? 'bg-[var(--color-bg-tertiary)]' : ''}`}
                >
                  <td className="py-1.5 pr-2">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={blocked}
                        onChange={() => onToggle(row.id)}
                        title={blocked
                          ? `${MAX_SELECTED} corners already plotted - untick one first.`
                          : undefined}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)] disabled:opacity-30"
                      />
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: on
                            ? colourFor(selectedIds, row.id)
                            : 'transparent',
                        }}
                      />
                    </label>
                  </td>

                  {/* Bare values -- the header already names the parameter,
                      and "n6" down an "n" column says it twice. */}
                  {keys.map((k) => (
                    <td key={k} className="py-1.5 pr-3">
                      {cornerValue(k, row.corner[k], row.attitude, num)}
                    </td>
                  ))}

                  <td className="py-1.5 pr-3 text-right text-[var(--color-text-primary)]">
                    {q(row.F_peak, 'force')}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{dec(row.descent_time, 1)} s</td>
                  <td className="py-1.5 pr-3 text-right">{q(row.impact_ke, 'energy')}</td>
                  <td className="py-1.5">
                    <span className="text-[var(--color-text-muted)]">
                      {candidateLabel(
                        `${row.governing_device} / ${row.governing_candidate}`,
                      ).device}{' '}
                      {candidateLabel(
                        `${row.governing_device} / ${row.governing_candidate}`,
                      ).what}
                    </span>
                    {marks.map((m) => (
                      <Badge key={m} tone="danger">worst {m}</Badge>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

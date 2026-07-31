/**
 * Every design, and what it scores. Also the show/hide control for the chart.
 *
 * The four metric columns are exactly the four figures the Recovery summary
 * shows, in the same order and through the same converters. That
 * correspondence is the point: a study exists to compare designs against the
 * run you would get by opening the Recovery tab on each of them one at a time,
 * and a fifth number here -- or a different definition of one of these four --
 * would quietly break it.
 *
 * Selection is merged into this table rather than given a list of its own. The
 * alternative is two lists of the same twenty things, and the one carrying the
 * metrics is the one people read.
 */

import type { StudyPoint, StudyResult } from '../../api/client'
import type { Device } from '../../types/schema'
import { CONTEXT_COLOUR, studyColour } from '../chartTheme'
import { Card, Toggle } from '../ui'
import { axisKind, axisTitle, axisValueLabel } from '../../lib/study'
import { useUnits } from '../../lib/unitsContext'

/** Which metric each column reads, and in what quantity. `kind: null` means
 *  the quantity has no imperial form -- seconds, in this table's case -- and
 *  `quantities.ts` deliberately offers no dropdown for it. */
const METRICS = [
  { key: 'descent_time', label: 'Descent', kind: null },
  { key: 'impact_velocity', label: 'Impact speed', kind: 'speed' },
  { key: 'impact_ke', label: 'Impact energy', kind: 'energy' },
  { key: 'F_peak', label: 'Max load', kind: 'force' },
] as const

export function StudyTable({
  result, hidden, onToggle, showContext, onShowContext, devices,
}: {
  result: StudyResult
  hidden: string[]
  onToggle: (id: string) => void
  showContext: boolean
  onShowContext: (v: boolean) => void
  devices: Device[]
}) {
  const { num, lab, dur } = useUnits()

  const cell = (m: (typeof METRICS)[number], row: {
    descent_time: number; impact_velocity: number
    impact_ke: number; F_peak: number | null
  }) => {
    if (m.key === 'descent_time') return dur(row.descent_time)
    const v = m.key === 'F_peak' ? row.F_peak : row[m.key]
    return num(v, m.kind!)
  }

  return (
    <Card
      title="Designs"
      subtitle="The same four figures the Recovery summary shows, one row per design."
      right={
        <Toggle
          checked={showContext}
          onChange={onShowContext}
          label="draw hidden ones in grey"
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className="py-1.5 pr-2 font-medium" />
              {result.axes.map((a) => (
                <th key={`${a.key}-${a.device}`} className="py-1.5 pr-3 font-medium">
                  {axisTitle(a)}
                  {(() => {
                    const k = axisKind(a, devices)
                    return k ? ` (${lab(k)})` : ''
                  })()}
                </th>
              ))}
              {METRICS.map((m) => (
                <th key={m.key} className="py-1.5 pr-3 text-right font-medium">
                  {m.label}
                  {m.kind ? ` (${lab(m.kind)})` : ' (s)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-[var(--color-text-secondary)]">
            {/* The current config, pinned on top. It is generally NOT one of
                the designs -- the canopy fitted today need not be among the
                ones being compared -- which is exactly why it is the thing
                every row below is read against. It also names the dashed white
                line, which is why the chart needs no legend of its own. */}
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40">
              {/* The dashed swatch names the chart's white reference line, and
                  the word names the row -- the axis columns now carry values,
                  so there is nowhere else for the label to live. */}
              <td
                className="whitespace-nowrap py-1.5 pr-2"
                title="The config you have now — the dashed white line on the chart."
              >
                <span className="flex items-center gap-1.5">
                  <span className="h-0 w-3 shrink-0 border-t-2 border-dashed border-white" />
                  <span className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    now
                  </span>
                </span>
              </td>
              {result.axes.map((a) => (
                <td key={`${a.key}-${a.device}`} className="py-1.5 pr-3">
                  {a.current === null ? (
                    /* Only a canopy axis can land here: the fitted chute is
                       not one of the ones being compared. Saying so is the
                       useful answer -- a blank cell reads as missing data,
                       and a drag area in a column of canopy names reads as a
                       different kind of thing. */
                    <span
                      className="italic text-[var(--color-text-muted)]"
                      title="The canopy fitted now is not among the ones being compared."
                    >
                      not compared
                    </span>
                  ) : (
                    axisValueLabel(a.current, axisKind(a, devices), num)
                  )}
                </td>
              ))}
              {METRICS.map((m) => (
                <td key={m.key} className="py-1.5 pr-3 text-right">
                  {cell(m, result.nominal)}
                </td>
              ))}
            </tr>

            {result.points.map((p: StudyPoint, i) => {
              const off = hidden.includes(p.id)
              return (
                <tr
                  key={p.id}
                  className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-bg-tertiary)]/40"
                >
                  <td className="py-1.5 pr-2">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={() => onToggle(p.id)}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      {/* The swatch IS the identity: the ten colours repeat
                          past ten designs and adjacent hues are close by
                          design, so the chart is never read on colour alone. */}
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: off ? CONTEXT_COLOUR : studyColour(i) }}
                      />
                    </label>
                  </td>
                  {result.axes.map((a) => (
                    <td
                      key={`${a.key}-${a.device}`}
                      className={`py-1.5 pr-3 ${off ? '' : 'text-[var(--color-text-primary)]'}`}
                    >
                      {axisValueLabel(p.values[a.key], axisKind(a, devices), num)}
                    </td>
                  ))}
                  {METRICS.map((m) => (
                    <td key={m.key} className="py-1.5 pr-3 text-right">
                      {cell(m, p)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

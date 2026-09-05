/**
 * The headline numbers, one row per quantity and one column per model.
 *
 * The single most important rule in this file: a model that does not compute a
 * quantity renders as **"not computed"**, never as a dash in a numeric column
 * and never as 0. Two of the seven rows have a genuine absence in them, and in
 * the load row an absence shown as a number reads as OpenRocket predicting no
 * load rather than OpenRocket having no opinion -- which is the difference
 * between "this is fine" and "nobody checked".
 */

import type { CrossMetric, CrossModel, CrossModelResult } from '../../api/client'
import { useUnits } from '../../../lib/units/unitsContext'
import { Card } from '../ui'
import { MODEL_COLOUR, MODEL_ORDER } from './models'

/** Past this the two models are not describing the same descent. */
const SPREAD_WARN = 1.25

function Spread({ value }: { value: number | null }) {
  const { dec } = useUnits()
  if (value === null) {
    return <span className="text-[var(--color-text-muted)]">-</span>
  }
  const wide = value >= SPREAD_WARN
  return (
    <span
      className={wide ? 'text-amber-400' : 'text-[var(--color-text-secondary)]'}
      title={wide
        ? 'The models disagree by more than 25% - worth understanding before trusting any of them.'
        : undefined}
    >
      {dec(value, 2)}×
    </span>
  )
}

export function CrosscheckTable({ metrics, models }: {
  metrics: CrossMetric[]
  models: Record<CrossModel, CrossModelResult>
}) {
  const { val, lab, dec } = useUnits()

  return (
    <Card title="Headline numbers" subtitle="Same config, three models.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="py-2 pr-4 font-medium text-[var(--color-text-secondary)]">
                Quantity
              </th>
              {MODEL_ORDER.map((id) => (
                <th key={id} className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: MODEL_COLOUR[id] }}
                    />
                    <span className="text-[var(--color-text-primary)]">
                      {models[id]?.label ?? id}
                    </span>
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium text-[var(--color-text-secondary)]">
                Spread
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              return (
                <tr
                  key={m.key}
                  className="border-b border-[var(--color-border)]/50"
                >
                  <td className="py-2 pr-4 text-[var(--color-text-primary)]">
                    {m.label}
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      {m.kind ? lab(m.kind) : m.unit}
                    </span>
                  </td>
                  {MODEL_ORDER.map((id) => {
                    const v = m.values[id]
                    return (
                      <td key={id} className="px-3 py-2 text-right tabular-nums">
                        {v === null ? (
                          <span
                            className="text-xs italic text-[var(--color-text-muted)]"
                            title={m.note ?? undefined}
                          >
                            not computed
                          </span>
                        ) : (
                          <span className="text-[var(--color-text-primary)]">
                            {dec(m.kind ? val(v, m.kind) : v, 2)}
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right tabular-nums">
                    <Spread value={m.spread} />
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

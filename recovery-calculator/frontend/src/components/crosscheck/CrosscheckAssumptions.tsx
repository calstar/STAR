/**
 * What the three models assume - shared first, then where they part company.
 *
 * This replaced a flat list of a dozen sentences tagged by model. The list was
 * unreadable for a specific reason: most of it was agreement, and a reader
 * scanning for "where do these differ" had to filter that out by eye. Splitting
 * the shared assumptions off and putting the rest in one row per aspect makes
 * the disagreement the thing you see.
 */

import type { CrossModelResult, CrossModel, ModelDifference } from '../../api/client'
import { Card, WarningsCard } from '../ui'
import { MODEL_COLOUR, MODEL_ORDER } from './models'

export function CrosscheckAssumptions({ shared, differs, models, warnings }: {
  shared: string[]
  differs: ModelDifference[]
  models: Record<CrossModel, CrosscheckModelLike>
  warnings: string[]
}) {
  return (
    <>
      <Card title="What all three assume">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {shared.map((line, i) => (
            <li
              key={i}
              className="font-prose text-xs leading-relaxed text-[var(--color-text-secondary)]"
            >
              <span className="text-[var(--color-text-muted)]">•</span> {line}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Where they differ">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left align-bottom">
                <th className="w-32 whitespace-nowrap py-2 pr-4 font-medium text-[var(--color-text-secondary)]">
                  Aspect
                </th>
                {MODEL_ORDER.map((id) => (
                  <th key={id} className="px-3 py-2 font-medium">
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
              </tr>
            </thead>
            <tbody>
              {differs.map((row) => (
                <tr
                  key={row.aspect}
                  className="border-b border-[var(--color-border)]/50 align-top"
                >
                  <td className="whitespace-nowrap py-2 pr-4 text-[var(--color-text-primary)]">
                    {row.aspect}
                  </td>
                  {MODEL_ORDER.map((id) => (
                    <td
                      key={id}
                      className="px-3 py-2 font-prose text-xs leading-relaxed text-[var(--color-text-secondary)]"
                    >
                      {row[id]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <WarningsCard warnings={warnings} />
    </>
  )
}

/** Only the label is needed here; kept structural so the panel can pass its
 *  `models` map straight through without reshaping it. */
type CrosscheckModelLike = Pick<CrossModelResult, 'label'>

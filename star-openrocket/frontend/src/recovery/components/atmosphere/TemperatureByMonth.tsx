/**
 * Troposphere temperature by month, one line per sounding dataset.
 *
 * "Temperature by month" is under-specified for a column of air, so there are
 * two readings of it and the chart offers both:
 *
 *   Temperature at a chosen height -- a horizontal slice through the column.
 *   Lapse rate over the whole band -- the single number eq (7) actually wants.
 *
 * The lapse view is the one that matters for the recovery model. eq (7) takes
 * a pad temperature and extrapolates a straight line up; L_fit is what the
 * soundings say that slope really is, and L_eq7 is what eq (7) would have
 * guessed from the same ascents' surface reading. The gap between those two
 * lines is the modelling error, per month, which is the whole reason this
 * dataset was collected.
 */

import { useMemo, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Climatology } from '../../types/climatology'
import { Card, Chip, Info, Select, Toggle } from '../ui'
import { AXIS, GRID, MARGIN, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import { monthName, seriesColour } from '../../lib/units'
import type { Kind } from '../../lib/quantities'
import { useUnits } from '../../lib/unitsContext'

type Metric = 'temperature' | 'lapse'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'temperature', label: 'Temperature at a height' },
  { value: 'lapse', label: 'Lapse rate' },
]

export function TemperatureByMonth({ clim }: { clim: Climatology }) {
  const datasets = clim.upper.datasets
  const grid = clim.upper.grid_m
  const padH = grid[0]

  const [shown, setShown] = useState<string[]>(
    () => datasets.filter((d) => d.pooled || d.id === 'vef').map((d) => d.id))
  const [metric, setMetric] = useState<Metric>('temperature')
  const [level, setLevel] = useState(0)
  const [showEq7, setShowEq7] = useState(true)
  const [showIsa, setShowIsa] = useState(true)
  const { val, lab, q, dec } = useUnits()
  // Lapse arrives from the climatology in K/km; the registry's base is K/m.
  const kind: Kind = metric === 'temperature' ? 'temperature' : 'lapse'
  const show = (v: number | null) =>
    v === null ? null : val(metric === 'lapse' ? v / 1000 : v, kind)

  const colourOf = useMemo(() => {
    const m: Record<string, string> = {}
    datasets.forEach((d, i) => { m[d.id] = seriesColour(i) })
    return m
  }, [datasets])

  const data = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const month = i + 1
      const row: Record<string, number | string | null> = {
        month, name: monthName(month),
      }
      // ISA is seasonless, so this is flat either way. At a height it is the
      // standard column's temperature there; for the lapse view it is -6.5.
      row.isa = show(metric === 'temperature'
        ? clim.isa.T[level]
        : clim.isa.lapse_k_per_km)
      for (const d of datasets) {
        if (metric === 'temperature') {
          const rec = clim.upper.profile[d.id]?.find((r) => r.month === month)
          row[d.id] = rec ? show(rec.mean[level] ?? null) : null
        } else {
          const rec = clim.upper.lapse[d.id]?.find((r) => r.month === month)
          row[d.id] = rec ? show(rec.L_mean) : null
          row[`${d.id}__eq7`] = rec ? show(rec.L_eq7) : null
        }
      }
      return row
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clim, datasets, metric, level, kind, val])

  function toggle(id: string) {
    setShown((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }

  const agl = q(grid[level] - padH, 'altitude')
  const isa = clim.meta.isa_lapse_k_per_km

  return (
    <Card
      title={
        <>
          {metric === 'temperature'
            ? `Temperature by month at ${agl} AGL`
            : `Lapse rate by month, 0–${q(25000 * 0.3048, 'altitude')}`}
          <Info>
            {metric === 'temperature'
              ? 'Mean of every usable ascent in that calendar month. Pooled '
                + 'datasets average the individual ascents, so a station that '
                + 'flies more often counts for more than half.'
              : 'Solid is what the soundings measured. Dashed is what the '
                + 'model infers from surface temperature alone, by drawing one '
                + 'straight line from the pad up to the standard tropopause. '
                + 'The gap is the error the measured profile removes.'}
          </Info>
        </>
      }
      right={
        <div className="w-56">
          <Select value={metric} onChange={setMetric} options={METRICS} />
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {datasets.map((d) => (
          <Chip
            key={d.id}
            active={shown.includes(d.id)}
            onClick={() => toggle(d.id)}
            colour={colourOf[d.id]}
            title={`${d.label} - ${d.n.toLocaleString('en-US')} soundings${d.pooled ? ', pooled' : ''}`}
          >
            {d.label}
            <span className="text-2xs text-[var(--color-text-muted)]">
              n={d.n.toLocaleString('en-US')}
            </span>
          </Chip>
        ))}
        <span className="ml-auto flex items-center gap-4">
          <Toggle checked={showIsa} onChange={setShowIsa} label="ISA baseline" />
          {metric === 'lapse' && (
            <Toggle checked={showEq7} onChange={setShowEq7}
                    label="Inferred from surface T" />
          )}
        </span>
      </div>

      {metric === 'temperature' && (
        <div className="mb-3 flex items-center gap-3">
          <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">
            Height
          </span>
          <input
            type="range"
            min={0}
            max={grid.length - 1}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)]"
          />
          <span className="w-40 shrink-0 text-right text-xs text-[var(--color-text-primary)]">
            {agl} AGL
            <span className="ml-1 text-[var(--color-text-muted)]">
              ({q(grid[level], 'altitude')} MSL)
            </span>
          </span>
        </div>
      )}

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={MARGIN}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="name" {...AXIS} />
            <YAxis
              {...AXIS}
              domain={['auto', 'auto']}
              width={70}
              tickFormatter={(v: number) => dec(v, metric === 'lapse' ? 1 : 0)}
              label={axisLabel(
                `${metric === 'temperature' ? 'T' : 'dT/dH'} (${lab(kind)})`, -90)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              formatter={(v: number | string, name: string) => [
                // Already in display units -- the data was converted, so this
                // only appends the label.
                `${dec(Number(v), metric === 'temperature' ? 2 : 3)} ${lab(kind)}`,
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

            {/* A Line rather than a ReferenceLine so it appears in the legend
                and the tooltip alongside the measured series -- the point is
                to read the gap off the chart, not just to see a rule. */}
            {showIsa && (
              <Line
                dataKey="isa"
                name={metric === 'temperature'
                  ? 'ISA standard column'
                  : `ISA lapse (${q(isa / 1000, 'lapse')})`}
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
              />
            )}

            {datasets.filter((d) => shown.includes(d.id)).map((d) => (
              <Line
                key={d.id}
                type="monotone"
                dataKey={d.id}
                name={d.label}
                stroke={colourOf[d.id]}
                strokeWidth={d.pooled ? 2.5 : 1.5}
                dot={{ r: 2 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}

            {metric === 'lapse' && showEq7
              && datasets.filter((d) => shown.includes(d.id)).map((d) => (
                <Line
                  key={`${d.id}__eq7`}
                  type="monotone"
                  dataKey={`${d.id}__eq7`}
                  name={`${d.label} - inferred from surface T`}
                  stroke={colourOf[d.id]}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SampleTable clim={clim} shown={shown} colourOf={colourOf} />
    </Card>
  )
}

/** Sounding counts per month. The reason this table is here rather than in a
 *  tooltip: the thinnest month drives how much any of these curves can be
 *  trusted, and pooling Edwards with China Lake exists precisely to lift that
 *  floor. A reader comparing a pooled line to a single-station line should be
 *  able to see the n behind each. */
function SampleTable({ clim, shown, colourOf }: {
  clim: Climatology
  shown: string[]
  colourOf: Record<string, string>
}) {
  const datasets = clim.upper.datasets.filter((d) => shown.includes(d.id))
  if (!datasets.length) return null
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="py-1.5 pr-3 font-medium">dataset</th>
            {Array.from({ length: 12 }, (_, i) => (
              <th key={i} className="py-1.5 pr-1 text-right font-medium">
                {monthName(i + 1)}
              </th>
            ))}
            <th className="py-1.5 pl-2 text-right font-medium"
                title="Thinnest month - what limits the whole curve.">min</th>
          </tr>
        </thead>
        <tbody className="text-[var(--color-text-secondary)]">
          {datasets.map((d) => {
            const rows = clim.upper.lapse[d.id] ?? []
            const counts = Array.from({ length: 12 }, (_, i) =>
              rows.find((r) => r.month === i + 1)?.n ?? 0)
            const min = Math.min(...counts)
            return (
              <tr key={d.id} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: colourOf[d.id] }} />
                    <span className="text-[var(--color-text-primary)]">{d.label}</span>
                  </span>
                </td>
                {counts.map((c, i) => (
                  <td key={i}
                      className={`py-1.5 pr-1 text-right ${c === min ? 'text-amber-400' : ''}`}>
                    {c}
                  </td>
                ))}
                <td className="py-1.5 pl-2 text-right text-[var(--color-text-primary)]">
                  {min}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

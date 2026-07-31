/**
 * Many flight histories on one set of axes.
 *
 * Shared by the Corners tab (one line per corner of the uncertainty sweep) and
 * the Sweep tab (one line per design in a trade study). The two ask opposite
 * questions and label their lines completely differently, but the drawing is
 * identical -- and the parts that are identical are the parts that were
 * subtle enough to get wrong once already, which is why they live in one place:
 *
 *   * the runs do NOT share a time grid, so the merged row set is mostly
 *     nulls and every line needs `connectNulls`;
 *   * the DATA is converted to the chosen unit, not just the axis label;
 *   * the reference run is painted last so it survives being overdrawn.
 */

import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { TrajectorySample } from '../types/schema'
import type { Channel } from './chartTheme'
import {
  AXIS, CHANNELS, CONTEXT_OPACITY, GRID, NOMINAL_COLOUR,
  TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel,
} from './chartTheme'
import { useUnits } from '../lib/unitsContext'

/** One line. `muted` is the anonymous context layer: drawn, but with no
 *  identity and no tooltip entry. */
export interface OverlaySeries {
  id: string
  label: string
  colour: string
  muted?: boolean
  trajectory: TrajectorySample[]
}

/** The reference run's series key. Cannot collide with a corner id ("c<n>") or
 *  a design point id ("p<n>"). */
const NOMINAL_KEY = '__nominal'

/** Past this many lines the tooltip stops being a readout and becomes a wall
 *  that covers the chart it is describing. The rest are counted, not listed --
 *  the table below carries every row anyway. */
const TOOLTIP_ROWS = 10

interface TipEntry { name?: string; value?: number; color?: string }

function Tip({ active, payload, label, unit }: {
  active?: boolean
  payload?: TipEntry[]
  label?: number
  unit: string
}) {
  const { dec } = useUnits()
  if (!active || !payload?.length) return null
  // Sorted by value so the lines nearest the cursor are the ones listed, which
  // is what makes a truncated tooltip usable rather than arbitrary.
  const rows = [...payload].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const shown = rows.slice(0, TOOLTIP_ROWS)
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '6px 10px' }}>
      <div style={TOOLTIP_LABEL_STYLE}>t = {dec(Number(label), 2)} s</div>
      {shown.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: r.color }} />
          <span className="text-[var(--color-text-secondary)]">{r.name}</span>
          <span className="ml-auto text-[var(--color-text-primary)]">
            {typeof r.value === 'number' ? dec(r.value, 2) : '—'} {unit}
          </span>
        </div>
      ))}
      {rows.length > shown.length && (
        <div className="text-[var(--color-text-muted)]">
          +{rows.length - shown.length} more
        </div>
      )}
    </div>
  )
}

export function TrajectoryOverlay({
  series, nominal, nominalLabel, channel, refLines = [], legend = true,
  className = 'h-[30rem]',
}: {
  /** Drawn in order, so put the ones that matter last. */
  series: OverlaySeries[]
  /** The reference run. Always drawn, always last, dashed white. */
  nominal: TrajectorySample[] | undefined
  nominalLabel: string
  channel: Channel
  /** Horizontal markers on the altitude channel, in SI. */
  refLines?: { name: string; y: number }[]
  /** Off when a table below already names every line -- 20 legend entries
   *  above a chart is a third of the plot area spent on a key that is
   *  duplicated two inches lower. */
  legend?: boolean
  className?: string
}) {
  const { val, lab, dec } = useUnits()
  const meta = CHANNELS.find((c) => c.key === channel)!
  // Convert the DATA, not just the label: the ticks, the tooltip, the
  // reference lines and the y domain all have to agree, and only one of them
  // ever reads the label.
  const show = (si: number) => val(si, meta.kind)
  const unit = lab(meta.kind) + (meta.suffix ?? '')

  // Merge on t so every run shares one x axis. They end at different times --
  // a bigger canopy descends a minute longer -- and that ragged right-hand
  // edge is exactly the comparison worth seeing, so series are left
  // null-terminated rather than padded.
  //
  // The runs do NOT share a time grid: each is adaptively sampled around its
  // own events, so two of them have ~59 timestamps in common out of ~400 and
  // the union is a row set in which any given series is present on roughly one
  // row in seven. Every line therefore needs `connectNulls` to bridge the rows
  // belonging to other runs -- without it the chart renders as disconnected
  // fragments while the tooltip still reports values, which is exactly as
  // confusing as it sounds. It does not paper over the ragged end: connectNulls
  // only joins non-null points, and past a run's last sample there are none.
  const byT = new Map<number, Record<string, number | null>>()
  for (const s of series) {
    for (const p of s.trajectory) {
      const row = byT.get(p.t) ?? { t: p.t }
      row[s.id] = show(p[channel])
      byT.set(p.t, row)
    }
  }
  for (const p of nominal ?? []) {
    const row = byT.get(p.t) ?? { t: p.t }
    row[NOMINAL_KEY] = show(p[channel])
    byT.set(p.t, row)
  }
  const data = [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number))

  const named = series.filter((s) => !s.muted)

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 34, left: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="t" type="number" {...AXIS}
            domain={[0, 'dataMax']}
            tickFormatter={(v: number) => dec(v, 0)}
            label={axisLabel('t (s)')}
          />
          <YAxis
            {...AXIS} width={70}
            tickFormatter={(v: number) => Math.abs(v) >= 1000
              // The `k` form is a magnitude abbreviation for a crowded
              // axis, not a precision choice, so it keeps its one decimal.
              ? (v / 1000).toFixed(1) + 'k'
              : dec(v, channel === 'CdS_tot' ? 2 : 0)}
            label={axisLabel(`${meta.label} (${unit})`, -90)}
          />

          {/* Deployment altitudes, so "opened low" is readable off the chart
              rather than inferred from a kink in the line. */}
          {channel === 'z' && refLines.map((r) => (
            <ReferenceLine
              key={r.name} y={show(r.y)} stroke="#9fb0c4"
              strokeDasharray="2 3" strokeWidth={1}
              label={{ value: r.name, position: 'insideTopLeft',
                       fill: '#cbd5e1', fontSize: 12, offset: 6 }}
            />
          ))}

          <Tooltip content={<Tip unit={unit} />} />

          {legend && named.length >= 1 && (
            <Legend
              verticalAlign="top" height={36}
              wrapperStyle={{ fontSize: 13, paddingBottom: 8 }}
              payload={[
                ...named.map((s) => ({
                  value: s.label, type: 'line' as const,
                  id: s.id, color: s.colour,
                })),
                { value: nominalLabel, type: 'line' as const,
                  id: NOMINAL_KEY, color: NOMINAL_COLOUR },
              ]}
            />
          )}

          {series.map((s) => (
            <Line
              key={s.id}
              dataKey={s.id}
              name={s.label}
              stroke={s.colour}
              strokeWidth={s.muted ? 1 : 2}
              strokeOpacity={s.muted ? CONTEXT_OPACITY : 1}
              // Twenty runs is ~8k points; dots would be 8k DOM nodes and the
              // animation on top of that is unusable.
              dot={false}
              isAnimationActive={false}
              connectNulls
              legendType="none"
              // The context layer is anonymous by design; listing its lines in
              // the tooltip would bury the ones actually chosen.
              tooltipType={s.muted ? 'none' : undefined}
            />
          ))}

          {/* Painted last so it stays legible over everything else. Dashed and
              white, deliberately outside both palettes -- it is a reference,
              not one of the runs. */}
          {(nominal?.length ?? 0) > 0 && (
            <Line
              dataKey={NOMINAL_KEY}
              name={nominalLabel}
              stroke={NOMINAL_COLOUR}
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
              connectNulls
              legendType="none"
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * Wind speed against altitude for the selected climatology month -- the wind
 * that is actually driving the drift, shown beside the track it produces.
 *
 * Altitude on X like every other profile in this app (see SoundingProfile for
 * why the app's own consistency beats the meteorologist's altitude-on-Y skew-T).
 * The mean is the line; the p05-p95 area is the day-to-day spread, and the p95
 * line is drawn too because it is the "worst-case wind" the tab can run.
 */

import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { WindMonth } from '../../types/climatology'
import { AXIS, GRID, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import { useUnits } from '../../lib/unitsContext'

export function WindProfileChart({ wm, grid, padH, worst }: {
  wm: WindMonth
  grid: number[]
  padH: number
  worst: boolean
}) {
  const { val, lab, dec } = useUnits()
  const spd = (ms: number) => val(ms, 'speed')

  const data = grid.map((H, i) => ({
    agl: Math.round(val(H - padH, 'altitude')),
    mean: spd(wm.spd[i]),
    p95: spd(wm.spd_p95[i]),
    band: [spd(wm.spd_p05[i]), spd(wm.spd_p95[i])] as [number, number],
  }))

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 30, left: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            type="number" dataKey="agl" domain={[0, 'dataMax']}
            {...AXIS} tickFormatter={(v: number) => v.toLocaleString('en-US')}
            label={axisLabel(`H (${lab('altitude')} AGL)`)}
          />
          <YAxis
            type="number" domain={[0, 'dataMax + 2']} width={52}
            {...AXIS} tickFormatter={(v: number) => dec(v, 0)}
            label={axisLabel(`wind (${lab('speed')})`, -90)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v: number) =>
              `${Number(v).toLocaleString('en-US')} ${lab('altitude')} AGL`}
            formatter={(v: number | string | (number | string)[], name: string) => {
              if (name === 'band') {
                const [lo, hi] = v as [number, number]
                return [`${dec(lo, 1)} – ${dec(hi, 1)} ${lab('speed')}`, 'p05–p95']
              }
              return [`${dec(Number(v), 1)} ${lab('speed')}`, name]
            }}
          />
          <Legend verticalAlign="top" height={26} wrapperStyle={{ fontSize: 11 }} />

          {/* One Area between the [lo, hi] tuple -- never two stacked Areas, and
              never wrapped in a fragment (Recharts drops fragment children). */}
          <Area
            dataKey="band" stroke="none" fill="var(--color-accent)"
            fillOpacity={0.1} legendType="none" isAnimationActive={false} activeDot={false}
          />
          <Line
            dataKey="p95" name="p95 (worst-case)"
            stroke="#ef4444" strokeWidth={worst ? 2.5 : 1.25}
            strokeDasharray="5 3" dot={false} isAnimationActive={false}
          />
          <Line
            dataKey="mean" name="mean"
            stroke="var(--color-accent)" strokeWidth={worst ? 1.25 : 2.5}
            dot={false} isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

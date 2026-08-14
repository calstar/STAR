/**
 * The horizontal ground track, plan view: where the vehicle goes as it comes
 * down, seen from above. East on X, North on Y, the pad at the origin.
 *
 * Equal aspect on purpose -- a square frame with a symmetric domain -- because
 * this is a map, not a plot: a drift that is mostly downrange should *look*
 * mostly downrange, and a stretched axis would lie about the bearing. The domain
 * is symmetric about the pad and floored at a small radius so a near-calm run
 * does not get zoomed up into what looks like a wild scribble.
 */

import {
  CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { DriftResult } from '../../types/schema'
import { AXIS, GRID, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import { useUnits } from '../../lib/unitsContext'
import { Empty } from '../ui'

export function GroundTrack({ drift }: { drift: DriftResult }) {
  const { val, lab, dec } = useUnits()
  const d = (m: number) => val(m, 'distance')

  if (drift.track.length < 2) {
    return <Empty>No descent to plot.</Empty>
  }

  const data = drift.track.map((p) => ({ xd: d(p.x), yd: d(p.y), z: p.z }))
  const xEnd = d(drift.landing.x)
  const yEnd = d(drift.landing.y)

  // Symmetric square domain about the pad, padded 15% and floored so a small
  // drift is not magnified into noise. 50 m is a sensible smallest full-scale.
  const reach = Math.max(...data.map((p) => Math.max(Math.abs(p.xd), Math.abs(p.yd))))
  const R = Math.max(reach * 1.15, d(50))
  const fmt = (v: number) => dec(v, 0)

  return (
    <div className="mx-auto aspect-square w-full max-w-[34rem]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 30, left: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            type="number" dataKey="xd" domain={[-R, R]}
            {...AXIS} tickFormatter={fmt} allowDecimals={false}
            label={axisLabel(`East (${lab('distance')})`)}
          />
          <YAxis
            type="number" domain={[-R, R]} width={56}
            {...AXIS} tickFormatter={fmt} allowDecimals={false}
            label={axisLabel(`North (${lab('distance')})`, -90)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(v: number | string, name: string) => {
              if (name === 'yd') return [`${dec(Number(v), 0)} ${lab('distance')} N`, 'north']
              return [`${dec(Number(v), 0)} ${lab('distance')}`, name]
            }}
          />

          {/* Crosshair through the pad, so the origin reads as the launch point. */}
          <ReferenceLine x={0} stroke="#4b5563" />
          <ReferenceLine y={0} stroke="#4b5563" />

          <Line
            dataKey="yd" name="track"
            stroke="var(--color-accent)" strokeWidth={2}
            dot={false} isAnimationActive={false}
          />

          {/* Pad at the origin, landing where the wind carried it. */}
          <ReferenceDot x={0} y={0} r={4} fill="#f8fafc" stroke="none" />
          <ReferenceDot x={xEnd} y={yEnd} r={5} fill="#ef4444" stroke="none" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

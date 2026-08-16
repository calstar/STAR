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
import { useUnits } from '../../../lib/units/unitsContext'
import { Empty } from '../ui'

const LANDING = '#ef4444'

/** One point on the track: East, North (both display units) and the altitude
 *  it was at. The default Recharts tooltip put the raw East float on the label
 *  line and called the North series "north", which read as noise; this names
 *  every value and drops the altitude in as the header. */
function TrackTip({ active, payload }: {
  active?: boolean
  payload?: { payload: { xd: number; yd: number; z: number } }[]
}) {
  const { dec, val, lab } = useUnits()
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const row = (name: string, v: number, unit: string) => (
    <div className="flex items-baseline gap-4 whitespace-nowrap">
      <span className="text-[var(--color-text-secondary)]">{name}</span>
      <span className="ml-auto text-[var(--color-text-primary)]">{dec(v, 0)} {unit}</span>
    </div>
  )
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '6px 10px' }}>
      <div style={TOOLTIP_LABEL_STYLE}>
        at {dec(val(p.z, 'altitude'), 0)} {lab('altitude')} AGL
      </div>
      {row('East', p.xd, lab('distance'))}
      {row('North', p.yd, lab('distance'))}
    </div>
  )
}

export function GroundTrack({ drift }: { drift: DriftResult }) {
  const { val, lab, dec } = useUnits()
  const d = (m: number) => val(m, 'distance')

  if (drift.track.length < 2) {
    return <Empty>No descent to plot.</Empty>
  }

  const data = drift.track.map((p) => ({ xd: d(p.x), yd: d(p.y), z: p.z }))
  // The EXACT landing coordinate in display units, for the landing dot.
  const xLand = d(drift.landing.x)
  const yLand = d(drift.landing.y)

  // Symmetric square domain about the pad, zoomed in as tight as the trace allows:
  // the half-extent is the farthest point from the pad plus a small margin, floored so
  // a near-calm drift is not magnified into noise. 50 m is a sensible smallest full-scale.
  const reach = Math.max(...data.map((p) => Math.max(Math.abs(p.xd), Math.abs(p.yd))))
  const R = Math.max(reach * 1.12, d(50))
  const ticks = [-R, -R / 2, 0, R / 2, R]
  // The axis unit is km/mi, so a sub-unit scale needs decimals or every tick reads 0.
  const decimals = R >= 2 ? 0 : R >= 0.2 ? 1 : 2
  const fmt = (v: number) => dec(v, decimals)

  return (
    <div className="mx-auto aspect-square w-full max-w-[34rem]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 30, left: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            type="number" dataKey="xd" domain={[-R, R]}
            {...AXIS} ticks={ticks} tickFormatter={fmt}
            label={axisLabel(`East (${lab('distance')})`)}
          />
          <YAxis
            type="number" domain={[-R, R]} width={56}
            {...AXIS} ticks={ticks} tickFormatter={fmt}
            label={axisLabel(`North (${lab('distance')})`, -90)}
          />
          <Tooltip content={<TrackTip />} />

          {/* Crosshair through the pad, so the origin reads as the launch point. */}
          <ReferenceLine x={0} stroke="#4b5563" />
          <ReferenceLine y={0} stroke="#4b5563" />

          <Line
            dataKey="yd" name="track"
            stroke="var(--color-accent)" strokeWidth={2}
            dot={false} isAnimationActive={false}
          />

          {/* The descent starts at apogee (the origin, above the pad), and the
              track curves from any lateral velocity there, bending into the wind
              down to the landing. Landing's East/North are the emphasised ticks. */}
          <ReferenceDot x={0} y={0} r={4} fill="#f8fafc" stroke="none"
            label={{ value: 'apogee', position: 'top', fontSize: 12,
                     fill: 'var(--color-text-secondary)' }} />
          <ReferenceDot x={xLand} y={yLand} r={5} fill={LANDING} stroke="none"
            label={{ value: 'landing', position: 'bottom', fontSize: 12, fill: LANDING }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

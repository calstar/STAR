/**
 * The SELECTED atmosphere the design flies through — temperature and pressure against
 * altitude for the chosen pad state, computed by the same `physics.atmosphere.Atmosphere`
 * the ascent and descent use (POST /api/atmosphere). This is the design's own column, as
 * opposed to the reference climatology on the Atmospheric Data subtab.
 *
 * Altitude on X, like every other profile in this app (see SoundingProfile / the wind
 * chart for why the app's own consistency beats the meteorologist's altitude-on-Y skew-T).
 */

import { useEffect, useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { resolveAtmosphere } from '../../recovery/api/client'
import type { AtmosphereProfilePoint } from '../../recovery/types/schema'
import { useUnits } from '../../lib/units/unitsContext'
import { Card, Empty } from '../../recovery/components/ui'
import {
  AXIS, GRID, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel,
} from '../../recovery/components/chartTheme'

export function SelectedAtmosphere({ site, maxAltitude }: {
  /** The resolved wire site — T_pad/p_pad/lapse the physics actually uses (any null =
   *  standard column / eq (7) re-fit). Pass `toWireConfig(ui).site`. */
  site: { T_pad: number | null; p_pad: number | null; lapse: number | null }
  /** Profile ceiling, m AGL — matched to the wind-aloft chart so all three share a range. */
  maxAltitude: number
}) {
  const { val, lab, dec } = useUnits()
  const [profile, setProfile] = useState<AtmosphereProfilePoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const key = `${site.T_pad}|${site.p_pad}|${site.lapse}|${Math.round(maxAltitude)}`
  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      resolveAtmosphere({
        T_pad: site.T_pad, p_pad: site.p_pad, lapse: site.lapse,
        max_altitude: Math.max(500, Math.round(maxAltitude)), samples: 60,
      }).then((res) => {
        if (cancelled) return
        if (res.data) { setProfile(res.data.profile); setError(null) }
        else { setError(res.error ?? 'atmosphere failed'); setProfile(null) }
      })
    }, 200)
    return () => { cancelled = true; clearTimeout(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const data = (profile ?? []).map((pt) => ({
    agl: Math.round(val(pt.z_agl, 'altitude')),
    T: val(pt.T, 'temperature'),
    p: val(pt.p, 'pressure'),
  }))

  return (
    <Card title="Selected atmosphere"
          subtitle="Temperature and pressure the physics uses for the chosen pad state — the same column the ascent and descent fly through.">
      {error ? (
        <Empty>{error}. The atmosphere profile needs the backend running.</Empty>
      ) : !profile ? (
        <Empty>Computing…</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Profile data={data} yKey="T" color="var(--color-accent)"
                   yLabel={`T (${lab('temperature')})`} unit={lab('temperature')}
                   width={56} tick={(v) => dec(v, 0)} tip={(v) => dec(v, 1)}
                   altLabel={lab('altitude')} yDomain={['dataMin - 4', 'dataMax + 4']} />
          <Profile data={data} yKey="p" color="#f59e0b"
                   yLabel={`p (${lab('pressure')})`} unit={lab('pressure')}
                   width={72} tick={(v) => dec(v, 0)} tip={(v) => dec(v, 0)}
                   altLabel={lab('altitude')} yDomain={['dataMin', 'dataMax']} />
        </div>
      )}
    </Card>
  )
}

function Profile({ data, yKey, color, yLabel, unit, width, tick, tip, altLabel, yDomain }: {
  data: { agl: number; T: number; p: number }[]
  yKey: 'T' | 'p'
  color: string
  yLabel: string
  unit: string
  width: number
  tick: (v: number) => string
  tip: (v: number) => string
  altLabel: string
  yDomain: [number | string, number | string]
}) {
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 30, left: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            type="number" dataKey="agl" domain={[0, 'dataMax']}
            {...AXIS} tickFormatter={(v: number) => v.toLocaleString('en-US')}
            label={axisLabel(`H (${altLabel} AGL)`)}
          />
          <YAxis
            type="number" domain={yDomain} width={width}
            {...AXIS} tickFormatter={(v: number) => tick(v)}
            label={axisLabel(yLabel, -90)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={(v: number) =>
              `${Number(v).toLocaleString('en-US')} ${altLabel} AGL`}
            formatter={(v: number) => [`${tip(Number(v))} ${unit}`, yKey === 'T' ? 'temperature' : 'pressure']}
          />
          <Line dataKey={yKey} stroke={color} strokeWidth={2.5}
                dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

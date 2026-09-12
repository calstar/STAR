/**
 * Estimated pad pressure at FAR, by month, one line per METAR station.
 *
 * The thing to understand about this chart: every line is an estimate of the
 * *same* number -- the station pressure at the FAR pad -- reached from a
 * different vantage point. None of them is a measurement at the pad, because
 * there is no station at the pad. Each is that station's altimeter setting run
 * through eq (7b) down to the pad elevation. That elevation is never written
 * out here -- it comes from `clim.meta.pad.elev_m`, because a restated copy
 * went stale the moment 610 m was corrected to 630 m.
 *
 * So the spread between the lines is not weather. It is the error bar on the
 * whole method, measured rather than assumed, which is why they belong on one
 * axis instead of three panels.
 */

import { useMemo, useState } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Climatology } from '../../types/climatology'
import { Card, Chip, Info, Select, Toggle } from '../ui'
import { AXIS, GRID, MARGIN, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import { monthName, seriesColour } from '../../lib/units'
import type { Kind } from '../../../lib/units/quantities'
import { useUnits } from '../../../lib/units/unitsContext'

type Metric = 'pressure' | 'density'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'pressure', label: 'Pad pressure, p_pad' },
  { value: 'density', label: 'Pad density, rho_pad' },
]

export function PressureByMonth({ clim }: { clim: Climatology }) {
  const stations = clim.surface.stations
  const [shown, setShown] = useState<string[]>(() => stations.map((s) => s.id))
  const [metric, setMetric] = useState<Metric>('pressure')
  const [spread, setSpread] = useState(true)
  const [showIsa, setShowIsa] = useState(true)
  const { u, val, lab, q, dec } = useUnits()
  const kind: Kind = metric === 'pressure' ? 'pressure' : 'density'

  const colourOf = useMemo(() => {
    const m: Record<string, string> = {}
    stations.forEach((s, i) => { m[s.id] = seriesColour(i) })
    return m
  }, [stations])

  // The p05-p95 band is per-station, and overlaying three translucent bands
  // turns the plot to mud, so it follows exactly one station.
  //
  // Which one is not arbitrary: the primary owns it, because the primary is
  // the station a run actually resolves p_pad from, so its spread is the one
  // that bounds a real number. Only when the primary is hidden does this fall
  // through, and then to the NEAREST remaining station rather than the first
  // in some incidental order.
  //
  // Both of those orderings were previously wrong. `stations` arrives
  // alphabetically, so "first shown" silently meant KEDW -- the FURTHEST
  // station, and not the primary. And `shown` is in click order, so toggling a
  // chip off and back on moved it to the end and made the band jump stations
  // with no visible cause.
  const bandStation = useMemo(() => {
    const visible = stations.filter((s) => shown.includes(s.id))
    if (!visible.length) return null
    const primary = visible.find((s) => s.primary)
    if (primary) return primary.id
    return visible.reduce((a, b) => (a.distance_km <= b.distance_km ? a : b)).id
  }, [stations, shown])

  type Row = Record<string, number | string | null | [number, number]>

  const data = useMemo(() => {
    // Convert the DATA, not just the axis label: the ticks, the tooltip, the
    // band tuple and the auto domain all have to agree.
    const show = (si: number | null) => (si === null ? null : val(si, kind))
    return Array.from({ length: 12 }, (_, i) => {
      const month = i + 1
      const row: Row = { month, name: monthName(month) }
      // Flat by construction: the standard atmosphere has no seasonality, and
      // seeing that against a curve with a real annual swing is the comparison.
      row.isa = show(metric === 'pressure' ? clim.isa.pad.p : clim.isa.pad.rho)
      for (const s of stations) {
        const rec = clim.surface.monthly[s.id]?.find((r) => r.month === month)
        if (!rec) { row[s.id] = null; continue }
        row[s.id] = show(metric === 'pressure' ? rec.p_mean : rec.rho_mean)
        if (s.id === bandStation) {
          const lo = show(metric === 'pressure' ? rec.p_p05 : rec.rho_p05)
          const hi = show(metric === 'pressure' ? rec.p_p95 : rec.rho_p95)
          // A range area: Recharts draws a single Area between the two values
          // of a [lo, hi] tuple. Do NOT build this from two stacked Areas --
          // stacking baselines the domain at zero, which flattens a 1 kPa
          // annual swing into a flat line at the top of a 0-100 kPa axis.
          row.band = lo !== null && hi !== null ? [lo, hi] : null
        }
      }
      return row
    })
  }, [clim, stations, metric, bandStation, kind, val])

  const unit = lab(kind)
  const digits = u(kind).digits

  function toggle(id: string) {
    setShown((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }

  return (
    <Card
      title={
        <>
          {metric === 'pressure' ? 'Pad pressure by month' : 'Pad density by month'}
          <Info>
            {metric === 'pressure'
              ? 'Each line is the same quantity estimated from a different '
                + 'METAR station. An altimeter setting is defined against the '
                + 'standard column, so inverting it at the pad height recovers '
                + 'station pressure there directly - the reporting station\'s '
                + 'own elevation never enters. Good to 0.3–0.6%.'
              : 'Density is pressure over temperature, so it carries both '
                + 'corrections. Pressure comes down the standard column, but '
                + 'temperature is the station reading carried across the '
                + `elevation gap at the assumed ${q(-0.0065, 'lapse')}. Dry air; humidity `
                + 'is neglected.'}
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
        {stations.map((s) => (
          <Chip
            key={s.id}
            active={shown.includes(s.id)}
            onClick={() => toggle(s.id)}
            colour={colourOf[s.id]}
            title={`${s.name} - ${q(s.distance_km * 1000, 'distance')}, ${s.gap_m > 0 ? '+' : ''}${q(s.gap_m, 'altitude')} elevation gap. ${s.note}`}
          >
            {s.id}
            {s.primary && (
              <span className="text-2xs text-[var(--color-accent)]">PRIMARY</span>
            )}
          </Chip>
        ))}
        <span className="ml-auto flex items-center gap-4">
          <Toggle
            checked={showIsa}
            onChange={setShowIsa}
            label="ISA baseline"
          />
          <span
            title={bandStation
              ? `Day-to-day spread for ${bandStation}, the primary station. `
                + 'Only one station carries a band, or the plot turns to mud.'
              : undefined}
          >
            <Toggle
              checked={spread}
              onChange={setSpread}
              label={bandStation
                ? `p05–p95 spread for ${bandStation}`
                : 'p05–p95 spread'}
            />
          </span>
        </span>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={MARGIN}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="name" {...AXIS} />
            <YAxis
              {...AXIS}
              domain={['auto', 'auto']}
              width={70}
              tickFormatter={(v: number) => dec(v, Math.max(0, digits - 1))}
              label={axisLabel(`${metric === 'pressure' ? 'p_pad' : 'rho_pad'} (${unit})`, -90)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              formatter={(v: number | string | (number | string)[], name: string) => {
                if (name === 'band') {
                  const [lo, hi] = v as [number, number]
                  return [`${dec(lo, digits)} – ${dec(hi, digits)} ${unit}`,
                          `${bandStation} p05–p95`]
                }
                return [`${dec(Number(v), digits)} ${unit}`, name]
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

            {/* Not wrapped in a fragment: Recharts scans its own `children`
                for known component types and does not flatten fragments, so a
                <>{...}</> here makes the Area silently vanish with no warning. */}
            {spread && bandStation && (
              <Area
                dataKey="band" stroke="none"
                fill={colourOf[bandStation]} fillOpacity={0.10}
                legendType="none" isAnimationActive={false} activeDot={false}
              />
            )}

            {showIsa && (
              <Line
                dataKey="isa"
                name="ISA standard column"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
              />
            )}

            {stations.filter((s) => shown.includes(s.id)).map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.id}
                stroke={colourOf[s.id]}
                strokeWidth={s.primary ? 2.5 : 1.5}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        {metric === 'pressure'
          ? `Extrapolated to the ${q(clim.meta.pad.elev_m, 'altitude')} pad down the standard column - the reporting station's elevation does not enter.`
          : `Extrapolated to the ${q(clim.meta.pad.elev_m, 'altitude')} pad: pressure down the standard column, temperature carried across the elevation gap at ${q(-0.0065, 'lapse')}.`}
      </p>

      <StationTable clim={clim} shown={shown} colourOf={colourOf} metric={metric} />
    </Card>
  )
}

/** The per-station facts that explain the lines: how far away, how much
 *  higher, and how many observations are behind each one. KMHV in particular
 *  has months with n=0 -- it went off the air Nov-Dec 2025 -- and a reader
 *  needs to see that rather than infer it from a gap in a line. */
function StationTable({ clim, shown, colourOf, metric }: {
  clim: Climatology
  shown: string[]
  colourOf: Record<string, string>
  metric: Metric
}) {
  const { q, dec } = useUnits()
  const kind: Kind = metric === 'pressure' ? 'pressure' : 'density'
  const stations = clim.surface.stations.filter((s) => shown.includes(s.id))
  if (!stations.length) {
    return (
      <p className="mt-4 text-center text-xs text-[var(--color-text-muted)]">
        No stations selected.
      </p>
    )
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="py-1.5 pr-3 font-medium">station</th>
            <th className="py-1.5 pr-3 font-medium">distance</th>
            <th className="py-1.5 pr-3 font-medium">elev gap</th>
            <th className="py-1.5 pr-3 font-medium">obs</th>
            <th className="py-1.5 pr-3 font-medium">
              annual mean {metric === 'pressure' ? 'p_pad' : 'rho_pad'}
            </th>
            <th className="py-1.5 pr-3 font-medium">vs ISA</th>
            <th className="py-1.5 font-medium">months with no data</th>
          </tr>
        </thead>
        <tbody className="text-[var(--color-text-secondary)]">
          {stations.map((s) => {
            const rows = clim.surface.monthly[s.id] ?? []
            const n = rows.reduce((a, r) => a + r.n, 0)
            const vals = rows
              .map((r) => metric === 'pressure' ? r.p_mean : r.rho_mean)
              .filter((v): v is number => v !== null)
            const mean = vals.length
              ? vals.reduce((a, b) => a + b, 0) / vals.length : null
            const gaps = rows.filter((r) => r.n === 0).map((r) => monthName(r.month))
            // What the ISA default costs, as a percentage. This is the number
            // §5 quotes as "~2% in density" - here it is, measured.
            const isaRef = metric === 'pressure' ? clim.isa.pad.p : clim.isa.pad.rho
            const dIsa = mean === null ? null : ((mean - isaRef) / isaRef) * 100
            return (
              <tr key={s.id} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: colourOf[s.id] }} />
                    <span className="text-[var(--color-text-primary)]">{s.id}</span>
                    <span className="text-[var(--color-text-muted)]">{s.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-3">{q(s.distance_km * 1000, 'distance')}</td>
                <td className="py-1.5 pr-3">
                  {s.gap_m > 0 ? '+' : ''}{q(s.gap_m, 'altitude')}
                </td>
                <td className="py-1.5 pr-3">{n.toLocaleString('en-US')}</td>
                <td className="py-1.5 pr-3 text-[var(--color-text-primary)]">
                  {mean === null ? '-' : q(mean, kind)}
                </td>
                <td className={`py-1.5 pr-3 ${Math.abs(dIsa ?? 0) > 1 ? 'text-amber-400' : ''}`}>
                  {dIsa === null ? '-'
                    : `${dIsa > 0 ? '+' : ''}${dec(dIsa, 2)} %`}
                </td>
                <td className="py-1.5 text-amber-400/80">
                  {gaps.length ? gaps.join(', ') : '-'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

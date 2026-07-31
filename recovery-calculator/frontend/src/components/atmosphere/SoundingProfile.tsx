/**
 * T against altitude for one chosen station and one chosen sounding dataset.
 *
 * Altitude on X, temperature on Y. That is the opposite of the skew-T
 * convention a meteorologist would reach for, and it is deliberate: every
 * other chart in this tool puts the independent variable on X, and the
 * recovery model reads temperature AS A FUNCTION OF height rather than the
 * other way round. Consistency inside the app beats convention borrowed from
 * outside it.
 *
 * Two kinds of "dataset" are selectable and they answer different questions:
 *
 *   A monthly climatology is what the recovery model should be sized against.
 *   It is smooth, and its p05-p95 band is the honest spread.
 *
 *   An individual ascent is what the air was actually doing on one morning.
 *   These routinely carry a surface inversion that the monthly mean smooths
 *   away entirely, and seeing one is the fastest way to understand why eq (7)
 *   -- a single straight line from the pad temperature -- goes wrong low down.
 *
 * The eq (7) overlay is drawn from the *displayed profile's own* surface
 * temperature, so it is a like-for-like comparison rather than a generic line.
 */

import { useMemo, useState } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Climatology, Sounding, UpperMonth } from '../../types/climatology'
import { Card, Empty, Select, Toggle } from '../ui'
import { AXIS, GRID, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabel } from '../chartTheme'
import { monthName } from '../../lib/units'
import { useUnits } from '../../lib/unitsContext'

type Source = 'climatology' | 'sounding'

export function SoundingProfile({ clim }: { clim: Climatology }) {
  const grid = clim.upper.grid_m
  const padH = grid[0]
  const { val, lab, q, dec } = useUnits()
  const T = (k: number | null) => (k === null ? null : val(k, 'temperature'))

  // Station keys come from the soundings bundle; labels from the single-station
  // datasets, which carry the human name.
  const stationOptions = useMemo(() => {
    const label: Record<string, string> = {}
    for (const d of clim.upper.datasets) {
      if (!d.pooled) label[d.stations[0]] = d.label
    }
    return Object.keys(clim.soundings)
      .sort()
      .map((k) => ({ value: k, label: `${k} — ${label[k] ?? k}` }))
  }, [clim])

  const [station, setStation] = useState(stationOptions[0]?.value ?? '')
  const [source, setSource] = useState<Source>('climatology')
  const [month, setMonth] = useState(1)
  const [soundingId, setSoundingId] = useState('')
  const [showEq7, setShowEq7] = useState(true)
  const [showIsa, setShowIsa] = useState(true)
  const [showBand, setShowBand] = useState(true)

  const soundings = clim.soundings[station] ?? []
  const selected = soundings.find((s) => s.id === soundingId) ?? soundings[0]

  // The single-station dataset tag for the chosen station, e.g. EDW -> 'edw'.
  const tag = useMemo(() => {
    const d = clim.upper.datasets.find(
      (x) => !x.pooled && x.stations[0] === station)
    return d?.id ?? null
  }, [clim, station])

  const monthRec = tag
    ? clim.upper.profile[tag]?.find((r) => r.month === month) ?? null
    : null

  const data = useMemo(() => {
    // The altitude is baked into the DATA here, not just the axis label,
    // because it is the chart's x key. `agl` rather than `agl_ft`: the unit is
    // whatever the Units tab says, and a name that claims otherwise would go
    // stale the first time someone picks metres.
    return grid.map((H, i) => {
      const row: Record<string, number | null | [number, number]> = {
        H,
        agl: Math.round(val(H - padH, 'altitude')),
        // From the bundle, not recomputed here: `export_json.py` evaluates it
        // with the same `physics.atmosphere` the solver uses, so no chart in
        // this app owns its own copy of the standard atmosphere.
        isa: T(clim.isa.T[i] ?? null),
      }

      if (source === 'climatology' && monthRec) {
        row.T = T(monthRec.mean[i])
        // Range area: one Area between the two values of a [lo, hi] tuple.
        // Never two stacked Areas -- stacking baselines the domain at zero.
        row.band = [val(monthRec.p05[i], 'temperature'),
                    val(monthRec.p95[i], 'temperature')]
        // eq7_err is (prediction - measured), so adding it back recovers the
        // eq (7) line without recomputing the re-fit in the browser.
        row.eq7 = T(monthRec.mean[i] + monthRec.eq7_err[i])
      } else if (source === 'sounding' && selected) {
        row.T = T(selected.t[i])
        row.eq7 = T(selected.t[0] + (selected.L_eq7 / 1000) * (H - padH))
        // Show the month's mean behind the ascent, for context.
        const ref = tag
          ? clim.upper.profile[tag]?.find((r) => r.month === selected.month)
          : null
        row.ref = ref ? T(ref.mean[i]) : null
      }
      return row
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, padH, source, monthRec, selected, clim, tag, val])

  const hasData = source === 'climatology' ? !!monthRec : !!selected

  const title = source === 'climatology'
    ? `${station} — ${monthName(month)} climatology`
    : selected ? `${station} — ${selected.label}` : station

  return (
    <Card
      title="Temperature against altitude"
    >
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-text-secondary)]">Station</span>
          <Select
            value={station}
            onChange={(v) => { setStation(v); setSoundingId('') }}
            options={stationOptions}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-text-secondary)]">Dataset</span>
          <Select
            value={source}
            onChange={setSource}
            options={[
              { value: 'climatology', label: 'Monthly climatology' },
              { value: 'sounding', label: 'Individual ascent' },
            ]}
          />
        </label>

        {source === 'climatology' ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">Month</span>
            <Select
              value={String(month)}
              onChange={(v) => setMonth(Number(v))}
              options={Array.from({ length: 12 }, (_, i) => {
                const rec = tag
                  ? clim.upper.profile[tag]?.find((r) => r.month === i + 1)
                  : null
                return {
                  value: String(i + 1),
                  label: `${monthName(i + 1)}${rec ? ` (n=${rec.n})` : ' (no data)'}`,
                }
              })}
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="text-xs text-[var(--color-text-secondary)]">
              Ascent
              <span className="ml-1 text-[var(--color-text-muted)]">
                ({soundings.length} most recent)
              </span>
            </span>
            <Select
              value={selected?.id ?? ''}
              onChange={setSoundingId}
              options={soundings.map((s) => ({
                value: s.id,
                label: `${s.label}   L_fit ${q(s.L_fit / 1000, 'lapse')}`,
              }))}
            />
          </label>
        )}

        <div className="flex flex-col justify-end gap-1.5">
          <Toggle checked={showEq7} onChange={setShowEq7} label="Inferred from surface T" />
          <Toggle checked={showIsa} onChange={setShowIsa} label="ISA column" />
          {source === 'climatology' && (
            <Toggle checked={showBand} onChange={setShowBand}
                    label="p05–p95 band" />
          )}
        </div>
      </div>

      {!hasData ? (
        <Empty>No soundings for that selection.</Empty>
      ) : (
        <>
          <div className="h-[28rem]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 8, right: 24, bottom: 30, left: 8 }}
              >
                <CartesianGrid {...GRID} />
                <XAxis
                  type="number"
                  dataKey="agl"
                  {...AXIS}
                  domain={[0, 'dataMax']}
                  tickFormatter={(v: number) => v.toLocaleString('en-US')}
                  label={axisLabel(`H (${lab('altitude')} AGL)`)}
                />
                <YAxis
                  type="number"
                  // No dataKey: this is the value axis now, and pinning it to
                  // "T" would size the domain from the mean alone and clip the
                  // p05-p95 band off the plot.
                  {...AXIS}
                  domain={['dataMin - 4', 'dataMax + 4']}
                  width={56}
                  tickFormatter={(v: number) => dec(v, 0)}
                  label={axisLabel(`T (${lab('temperature')})`, -90)}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  labelFormatter={(v: number) =>
                    `${Number(v).toLocaleString('en-US')} ${lab('altitude')} AGL`}
                  formatter={(v: number | string | (number | string)[], name: string) => {
                    if (name === 'band') {
                      const [lo, hi] = v as [number, number]
                      return [`${dec(lo, 1)} – ${dec(hi, 1)} ${lab('temperature')}`,
                              'p05–p95']
                    }
                    return [`${dec(Number(v), 2)} ${lab('temperature')}`, name]
                  }}
                />
                {/* Top-aligned: this is the only chart here with an X-axis
                    label, and a bottom legend lands on top of it. */}
                <Legend
                  verticalAlign="top"
                  height={26}
                  wrapperStyle={{ fontSize: 11 }}
                />

                {/* Never inside a fragment -- Recharts does not flatten
                    fragments when it scans its children, so a wrapped <Area>
                    silently never renders and nothing warns. */}
                {source === 'climatology' && showBand && (
                  <Area
                    dataKey="band" stroke="none"
                    fill="var(--color-accent)" fillOpacity={0.10}
                    legendType="none" isAnimationActive={false} activeDot={false}
                  />
                )}

                {showIsa && (
                  <Line
                    dataKey="isa" name="ISA standard column"
                    stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6 4"
                    dot={false} isAnimationActive={false}
                  />
                )}

                {source === 'sounding' && (
                  <Line
                    dataKey="ref" name="month mean"
                    stroke="#14b8a6" strokeWidth={1} strokeDasharray="2 3"
                    dot={false} isAnimationActive={false} connectNulls
                  />
                )}

                {showEq7 && (
                  <Line
                    dataKey="eq7" name="inferred from surface T"
                    stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3"
                    dot={false} isAnimationActive={false}
                  />
                )}

                <Line
                  dataKey="T" name={title}
                  stroke="var(--color-accent)" strokeWidth={2.5}
                  dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <ProfileFacts
            clim={clim} source={source} monthRec={monthRec}
            sounding={source === 'sounding' ? selected : undefined}
            grid={grid} padH={padH} tag={tag} month={month}
          />
        </>
      )}
    </Card>
  )
}

/** The numbers a reader would otherwise have to eyeball off the chart: how
 *  wrong eq (7) is at the top of the band, and by how much that moves density.
 *  rho ~ 1/T at fixed pressure, so a temperature error is a density error of
 *  the opposite sign and similar relative size -- which is the form the
 *  recovery model actually cares about. */
function ProfileFacts({ clim, source, monthRec, sounding, grid, padH, tag, month }: {
  clim: Climatology
  source: Source
  monthRec: UpperMonth | null
  sounding?: Sounding
  grid: number[]
  padH: number
  tag: string | null
  month: number
}) {
  const top = grid.length - 1
  const lapseRec = tag
    ? clim.upper.lapse[tag]?.find(
        (r) => r.month === (source === 'sounding' && sounding ? sounding.month : month))
    : null

  let eq7Top: number | null = null
  let tTop: number | null = null
  let lFit: number | null = null
  let lEq7: number | null = null
  let n: number | null = null

  if (source === 'climatology' && monthRec) {
    tTop = monthRec.mean[top]
    eq7Top = monthRec.eq7_err[top]
    lFit = lapseRec?.L_mean ?? null
    lEq7 = lapseRec?.L_eq7 ?? null
    n = monthRec.n
  } else if (sounding) {
    tTop = sounding.t[top]
    eq7Top = sounding.t[0] + (sounding.L_eq7 / 1000) * (grid[top] - padH) - tTop
    lFit = sounding.L_fit
    lEq7 = sounding.L_eq7
  }

  const drho = eq7Top !== null && tTop ? (-eq7Top / tTop) * 100 : null
  const cell = 'rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2'
  const { num, q, lab, dec } = useUnits()

  return (
    <div className="mt-4 grid grid-cols-2 gap-2 text-xs lg:grid-cols-5">
      <div className={cell}>
        <div className="text-2xs uppercase text-[var(--color-text-muted)]">
          surface T
        </div>
        <div className="mt-0.5 text-[var(--color-text-primary)]">
          {q(source === 'climatology' ? monthRec?.mean[0] : sounding?.t[0], 'temperature')}
        </div>
      </div>
      <div className={cell}>
        <div className="text-2xs uppercase text-[var(--color-text-muted)]">
          T at {q(grid[top] - padH, 'altitude')}
        </div>
        <div className="mt-0.5 text-[var(--color-text-primary)]">
          {q(tTop, 'temperature')}
        </div>
      </div>
      <div className={cell}>
        <div className="text-2xs uppercase text-[var(--color-text-muted)]">
          measured / inferred
        </div>
        <div className="mt-0.5 text-[var(--color-text-primary)]">
          {num(lFit === null ? null : lFit / 1000, 'lapse')}
          {' / '}
          {num(lEq7 === null ? null : lEq7 / 1000, 'lapse')}
          <span className="ml-1 text-2xs text-[var(--color-text-muted)]">
            {lab('lapse')}
          </span>
        </div>
      </div>
      <div className={cell}>
        <div className="text-2xs uppercase text-[var(--color-text-muted)]">
          error at top
        </div>
        {/* `tempDelta`, NOT `temperature`. This is a DIFFERENCE between the
            eq (7) line and the measured profile. Through the absolute K->°F
            map a 2 K error would read as 35.6 °F, which looks like a
            catastrophically bad model rather than a good one. */}
        <div className={`mt-0.5 ${Math.abs(eq7Top ?? 0) > 3 ? 'text-amber-400' : 'text-[var(--color-text-primary)]'}`}>
          {eq7Top === null ? '—'
            : `${eq7Top > 0 ? '+' : ''}${q(eq7Top, 'tempDelta')}`}
        </div>
      </div>
      <div className={cell}>
        <div className="text-2xs uppercase text-[var(--color-text-muted)]">
          implied rho error
        </div>
        <div className={`mt-0.5 ${Math.abs(drho ?? 0) > 1 ? 'text-amber-400' : 'text-[var(--color-text-primary)]'}`}>
          {drho === null ? '—' : `${drho > 0 ? '+' : ''}${dec(drho, 2)} %`}
          {n !== null && (
            <span className="ml-1 text-2xs text-[var(--color-text-muted)]">
              n={n}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

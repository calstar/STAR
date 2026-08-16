/**
 * Flight Dynamics tab: a 6-DOF ascent (RocketPy) driven by the CAD rocket.
 *
 * Ascent only (rail -> apogee); descent/recovery is the recovery calculator's job.
 * Aero uses RocketPy's native surfaces; the stability panel overlays our CP(M) margin
 * against RocketPy's for comparison (the "CP model" selector picks which curve(s) show).
 * Drag and inertia are approximations (see FUTURE_IMPROVEMENTS.md) -- stability panels are
 * exact, performance tiles (apogee, max-Q) are flagged approximate.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { computeFlightDynamics } from '../../api/client'
import type { FlightParams } from '../../types/config'
import type { FaceRef, FlightDynamicsResult, FlightDynamicsSample, MotorSelection } from '../../types'
import { AXIS, FD, GRID, REFERENCE, SERIES, TICK_FONT, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE, axisLabelX, axisLabelY } from './chartTheme'

interface Props {
  modelId: string | null
  motorSel: MotorSelection | null
  outerFaces: FaceRef[]
  finFaces: FaceRef[]
  nFins: number
  railLength: number
  overrides: Record<string, number>
  /** Launch params, owned by App so they are versioned in the config. */
  flight: FlightParams
  onFlightChange: (patch: Partial<FlightParams>) => void
  /** Last run result, owned by App so it survives tab switches. */
  result: FlightDynamicsResult | null
  onResult: (result: FlightDynamicsResult | null) => void
}

const G = 9.80665

/** Round up to a clean 1/2/5×10ⁿ, so axis ticks derived from it are round numbers. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const base = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / base
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base
}

export function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${warn ? 'border-rose-500/40 bg-rose-500/10' : 'border-slate-700 bg-slate-900/60'}`}>
      <div className="text-2xs uppercase tracking-wide text-slate-300">{label}</div>
      <div className={`text-lg font-semibold ${warn ? 'text-rose-300' : 'text-slate-100'}`}>{value}</div>
      {sub && <div className="text-2xs text-slate-400">{sub}</div>}
    </div>
  )
}

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
)

export function Panel({ title, hint, children, heightClass = 'min-h-[360px]' }: { title?: string; hint?: string; children: React.ReactNode; heightClass?: string }) {
  const [expanded, setExpanded] = useState(false)

  // Escape closes the expanded view.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  return (
    <div className={`relative flex flex-col rounded-lg border border-slate-700 bg-slate-900/40 p-3 ${heightClass}`}>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="Expand"
        className="absolute right-2 top-2 z-10 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      >
        <ExpandIcon />
      </button>
      {(title || hint) && (
        <div className="mb-1 pr-8">
          {title && <div className="text-sm font-semibold text-slate-200">{title}</div>}
          {hint && <div className="text-2xs leading-tight text-slate-400">{hint}</div>}
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>

      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setExpanded(false)}
          >
            <div
              className="flex h-[min(940px,96vh)] w-[min(1500px,97vw)] flex-col rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-start justify-between gap-4">
                <div>
                  {title && <div className="text-base font-semibold text-slate-100">{title}</div>}
                  {hint && <div className="text-xs text-slate-400">{hint}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600"
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

const tip = { contentStyle: TOOLTIP_STYLE, labelStyle: TOOLTIP_LABEL_STYLE }

/** Selectable time series for the compare overlay: each is one colored Y axis. */
interface SeriesDef {
  key: string
  label: string // includes unit, e.g. "Altitude (m)"
  unit: string
  color: string
  get: (s: FlightDynamicsSample) => number | null
  fmt: (v: number) => string
}

const COMPARE_SERIES: SeriesDef[] = [
  { key: 'altitude', label: 'Altitude (m)', unit: 'm', color: SERIES.altitude, get: (s) => s.altitude, fmt: (v) => v.toFixed(0) },
  { key: 'speed', label: 'Speed (m/s)', unit: 'm/s', color: SERIES.velocity, get: (s) => s.speed, fmt: (v) => v.toFixed(0) },
  { key: 'acceleration', label: 'Accel (m/s²)', unit: 'm/s²', color: SERIES.acceleration, get: (s) => s.acceleration, fmt: (v) => v.toFixed(0) },
  { key: 'dynamicPressure', label: 'Dyn. pressure (kPa)', unit: 'kPa', color: FD.pressure, get: (s) => s.dynamicPressure / 1000, fmt: (v) => v.toFixed(1) },
  { key: 'angleOfAttack', label: 'Angle of attack (°)', unit: '°', color: FD.aoa, get: (s) => s.angleOfAttack, fmt: (v) => v.toFixed(1) },
  { key: 'angleFromVertical', label: 'Angle from vertical (°)', unit: '°', color: FD.mach, get: (s) => s.angleFromVertical, fmt: (v) => v.toFixed(1) },
  { key: 'stabilityMarginOurs', label: 'Margin — ours (cal)', unit: 'cal', color: FD.marginOurs, get: (s) => s.stabilityMarginOurs, fmt: (v) => v.toFixed(2) },
  { key: 'stabilityMarginRocketpy', label: 'Margin — RocketPy (cal)', unit: 'cal', color: FD.marginRocketpy, get: (s) => s.stabilityMarginRocketpy, fmt: (v) => v.toFixed(2) },
  { key: 'bendingMoment', label: 'Bending (N·m)', unit: 'N·m', color: FD.bending, get: (s) => s.bendingMoment, fmt: (v) => v.toFixed(1) },
  { key: 'omegaPitch', label: 'Pitch rate (rad/s)', unit: 'rad/s', color: FD.omega, get: (s) => s.omegaPitch, fmt: (v) => v.toFixed(2) },
]

/** First sample time at or above a Mach threshold, for the transonic/supersonic markers. */
function machCrossTime(samples: FlightDynamicsSample[], mach: number): number | null {
  const hit = samples.find((s) => s.mach >= mach)
  return hit ? hit.t : null
}

/** A single-series line vs time, with shared axis styling. */
function TimeLine({
  data,
  yKey,
  color,
  name,
  unit,
  yLabel,
  fmt = (v: number) => v.toFixed(0),
}: {
  data: object[]
  yKey: string
  color: string
  name: string
  unit: string
  /** Y-axis title incl. units, e.g. "AoA (°)". Falls back to `name (unit)`. */
  yLabel?: string
  fmt?: (v: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
        <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
        <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('Time (s)')} />
        <YAxis stroke={color} tick={{ fontSize: TICK_FONT, fill: color }} tickLine={false} width={64} tickFormatter={fmt} label={axisLabelY(yLabel ?? (unit ? `${name} (${unit})` : name))} />
        <Tooltip {...tip} formatter={(v: number) => [`${fmt(v)} ${unit}`, name]} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} />
        <Line type="monotone" dataKey={yKey} name={name} stroke={color} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function FlightDynamicsTab({ modelId, motorSel, outerFaces, finFaces, nFins, railLength, overrides, flight, onFlightChange, result, onResult }: Props) {
  const { inclination, heading, windSpeed, windDirection, cpModel } = flight

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which series to overlay on the shared-time compare plot (default: the core two).
  const [compare, setCompare] = useState<Set<string>>(() => new Set(['altitude', 'speed']))
  const toggleCompare = (key: string) =>
    setCompare((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  async function run() {
    if (!modelId || !motorSel) return
    setBusy(true)
    setError(null)
    try {
      const res = await computeFlightDynamics(modelId, {
        outerFaces,
        finFaces: finFaces.length ? finFaces : null,
        nFins: nFins || null,
        overrides,
        motor: motorSel,
        railLength,
        inclination,
        heading,
        windSpeed,
        windDirection,
      })
      onResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const samples = result?.samples ?? []
  const track = samples.map((s) => ({ x: s.driftX, y: s.driftY, t: s.t }))
  const apogeePt = track.at(-1)
  // Symmetric, origin-centered extent so the ground track reads as four quadrants
  // of drift around the pad. Snapped up to a round 1/2/5×10ⁿ so the axis ticks land
  // on meaningful values (…-50, 0, 50…) instead of Recharts' auto 11.5-style ticks.
  const driftDomain = niceCeil(Math.max(10, ...track.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])) * 1.1)
  const driftTicks = [-driftDomain, -driftDomain / 2, 0, driftDomain / 2, driftDomain]

  const compareSeries = COMPARE_SERIES.filter((d) => compare.has(d.key))
  // One row per sample with every series pre-scaled to display units (e.g. q→kPa),
  // so each Line can use a plain string dataKey.
  const compareData = samples.map((s) => {
    const row: Record<string, number | null> = { t: s.t }
    for (const d of COMPARE_SERIES) row[d.key] = d.get(s)
    return row
  })
  // Vertical guides for the compressibility regimes on the compare plot.
  const machMarks = [
    { m: 0.8, label: 'transonic', t: machCrossTime(samples, 0.8) },
    { m: 1.2, label: 'supersonic', t: machCrossTime(samples, 1.2) },
  ].filter((x): x is { m: number; label: string; t: number } => x.t != null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-950 p-4">
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <Field label="Rail angle (° from horiz, 90=up)" value={inclination} set={(v) => onFlightChange({ inclination: v })} min={0} max={90} />
        <Field label="Heading (° from N)" value={heading} set={(v) => onFlightChange({ heading: v })} min={0} max={360} />
        <Field label="Wind (m/s)" value={windSpeed} set={(v) => onFlightChange({ windSpeed: v })} min={0} max={40} step={0.5} />
        <Field label="Wind from (° bearing)" value={windDirection} set={(v) => onFlightChange({ windDirection: v })} min={0} max={360} />
        <label className="flex flex-col text-xs text-slate-300">
          CP model
          <select value={cpModel} onChange={(e) => onFlightChange({ cpModel: e.target.value as FlightParams['cpModel'] })} className="mt-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100">
            <option value="both">Both (compare)</option>
            <option value="ours">Ours (CAD Barrowman)</option>
            <option value="rocketpy">RocketPy native</option>
          </select>
        </label>
        <button
          onClick={run}
          disabled={busy || !modelId || !motorSel}
          className="ml-auto rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-cyan-500 disabled:opacity-40"
        >
          {busy ? 'Simulating…' : 'Run flight'}
        </button>
      </div>
      <p className="mb-3 text-2xs text-slate-400">
        Launch site: Friends of Amateur Rocketry (FAR), 630 m — fixed. Wind is a constant
        placeholder until the site wind climatology merges in.
      </p>

      {!motorSel && <p className="text-sm text-amber-300">Select a motor in the CAD tab first — a flight needs one.</p>}
      {error && <p className="text-sm text-rose-400">{error}</p>}

      {result && (
        <>
          {!result.launchStable && (
            <p className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              Unstable at ignition (static margin ≤ 0) — the trajectory below is not trustworthy. Check fin/CG placement.
            </p>
          )}

          {/* Summary tiles */}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Tile label="Apogee" value={`${result.apogee.toFixed(0)} m`} sub={`at ${result.apogeeTime.toFixed(1)} s · approx drag`} />
            <Tile label="Max velocity" value={`${result.maxSpeed.toFixed(0)} m/s`} sub={`Mach ${result.maxMach.toFixed(2)}`} />
            <Tile label="Max-Q" value={`${(result.maxDynamicPressure / 1000).toFixed(1)} kPa`} sub={`at ${result.maxDynamicPressureTime.toFixed(1)} s`} />
            <Tile label="Max accel" value={`${(result.maxAcceleration / G).toFixed(1)} g`} />
            <Tile label="Off-rail" value={`${result.outOfRailVelocity.toFixed(1)} m/s`} sub={`${result.outOfRailStabilityMargin.toFixed(2)} cal`} warn={result.outOfRailStabilityMargin < 1} />
            <Tile label="Min margin" value={`${result.minStabilityMargin.toFixed(2)} cal`} sub={result.minStabilityMarginOurs != null ? `ours ${result.minStabilityMarginOurs.toFixed(2)}` : undefined} warn={result.minStabilityMargin < 1} />
            <Tile label="Max AoA" value={`${result.maxAngleOfAttack.toFixed(1)}°`} />
            <Tile label="Drift @ apogee" value={`${result.driftDistance.toFixed(0)} m`} sub={`bearing ${result.driftBearing.toFixed(0)}°`} />
          </div>

          {/* Full-width overlay: compare any time series on a shared time axis. */}
          <div className="mb-2">
            <h3 className="text-base font-semibold text-slate-100">Compare series</h3>
            <p className="text-2xs text-slate-400">Overlay any time series on the same time axis — each gets its own colored Y axis. Dashed guides mark the transonic and supersonic crossings.</p>
          </div>
          <div className="mb-5">
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2">
              {COMPARE_SERIES.map((d) => (
                <label key={d.key} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={compare.has(d.key)} onChange={() => toggleCompare(d.key)} style={{ accentColor: d.color }} />
                  <span style={{ color: d.color }}>{d.label}</span>
                </label>
              ))}
            </div>
            <Panel heightClass="h-[460px]">
              {compareSeries.length === 0 ? (
                <div className="flex h-full min-h-[240px] items-center justify-center text-xs text-slate-400">Select one or more series to plot.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={compareData} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
                    <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                    <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('Time (s)')} />
                    {compareSeries.map((d, i) => (
                      <YAxis key={d.key} yAxisId={d.key} orientation={i % 2 === 0 ? 'left' : 'right'} stroke={d.color} tick={{ fontSize: TICK_FONT, fill: d.color }} tickLine={false} width={56} tickFormatter={d.fmt} />
                    ))}
                    <Tooltip {...tip} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} formatter={(v: number, n: string) => { const d = COMPARE_SERIES.find((s) => s.label === n); return [`${d ? d.fmt(v) : v} ${d?.unit ?? ''}`, n] }} />
                    <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: TICK_FONT, paddingTop: 8 }} />
                    {machMarks.map((mk) => (
                      <ReferenceLine key={mk.label} yAxisId={compareSeries[0].key} x={mk.t} stroke={REFERENCE} strokeDasharray="4 3" label={{ value: mk.label, fill: REFERENCE, fontSize: TICK_FONT, position: 'top' }} />
                    ))}
                    {compareSeries.map((d) => (
                      <Line key={d.key} yAxisId={d.key} type="monotone" dataKey={d.key} name={d.label} stroke={d.color} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          {/* Other plots */}
          <div className="mb-2">
            <h3 className="text-base font-semibold text-slate-100">Other plots</h3>
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {/* Square so equal East/North scales read as true distances. */}
            <div className="aspect-square w-full">
            <Panel heightClass="h-full" title="Ground track" hint="Top-down path of the horizontal displacement, pad→apogee. Shows which way — and how far — the wind throws it.">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={track} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
                  <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                  <XAxis type="number" dataKey="x" name="East" domain={[-driftDomain, driftDomain]} ticks={driftTicks} stroke={AXIS.stroke} tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('East drift (m)')} />
                  <YAxis type="number" dataKey="y" name="North" domain={[-driftDomain, driftDomain]} ticks={driftTicks} stroke={AXIS.stroke} tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false} width={64} tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelY('North drift (m)')} />
                  <Tooltip
                    {...tip}
                    itemStyle={{ color: '#e2e8f0' }}
                    formatter={(v: number, _n, item: { payload?: { x: number } }) => [`E ${item.payload?.x.toFixed(0)} m, N ${v.toFixed(0)} m`, 'position']}
                    labelFormatter={(_x, payload) => { const t = (payload?.[0]?.payload as { t?: number } | undefined)?.t; return t != null ? `t = ${t.toFixed(1)} s` : '' }}
                  />
                  {/* Quadrant cross through the pad, so drift direction reads at a glance. */}
                  <ReferenceLine x={0} stroke={AXIS.stroke} strokeOpacity={0.5} />
                  <ReferenceLine y={0} stroke={AXIS.stroke} strokeOpacity={0.5} />
                  <Line type="linear" dataKey="y" stroke={FD.drift} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                  <ReferenceDot x={0} y={0} r={4} fill={REFERENCE} stroke="none" label={{ value: 'pad', fill: REFERENCE, fontSize: TICK_FONT, position: 'left' }} />
                  {apogeePt && <ReferenceDot x={apogeePt.x} y={apogeePt.y} r={4} fill={FD.drift} stroke="none" label={{ value: 'apogee', fill: FD.drift, fontSize: TICK_FONT, position: 'right' }} />}
                </LineChart>
              </ResponsiveContainer>
            </Panel>
            </div>

            <div className="flex flex-col gap-3">
              <Panel heightClass="h-[340px]" title="Pitch rate" hint="Dynamic stability: the pitch angular rate over time — how the rocket rotates in response to disturbances.">
                <TimeLine data={samples} yKey="omegaPitch" color={FD.omega} name="ω pitch" unit="rad/s" yLabel="Pitch rate (rad/s)" fmt={(v) => v.toFixed(2)} />
              </Panel>

              <Panel heightClass="h-[340px]" title="Attitude frequency response (FFT)" hint="FFT of the attitude angle — its peak is the oscillation frequency, i.e. how fast the rocket settles after a gust.">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={result.fft.frequency.map((f, i) => ({ f, a: result.fft.amplitude[i] }))} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
                    <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                    <XAxis dataKey="f" type="number" domain={[0, 20]} stroke={AXIS.stroke} tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('Frequency (Hz)')} />
                    <YAxis stroke={FD.fft} tick={{ fontSize: TICK_FONT, fill: FD.fft }} tickLine={false} width={56} label={axisLabelY('Amplitude')} />
                    <Tooltip {...tip} formatter={(v: number) => [v.toFixed(3), 'amp']} labelFormatter={(f: number) => `${f.toFixed(2)} Hz`} />
                    <Line type="monotone" dataKey="a" name="attitude FFT" stroke={FD.fft} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            </div>
          </div>

          <div className="mt-3 rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-2xs text-slate-400">
            Approximations in this run: {result.approximations.join(' · ')}. Stability outputs are exact;
            apogee / max-Q depend on the drag model. See FUTURE_IMPROVEMENTS.md.
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, value, set, min, max, step = 1 }: { label: string; value: number; set: (n: number) => void; min: number; max: number; step?: number }) {
  return (
    <label className="flex flex-col text-xs text-slate-300">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => set(Number(e.target.value))}
        className="mt-1 w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100"
      />
    </label>
  )
}

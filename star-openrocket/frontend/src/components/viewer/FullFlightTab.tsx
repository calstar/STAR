/**
 * Full Flight: the ascent (RocketPy) and the descent (coupled recovery) stitched
 * into one end-to-end picture -- altitude / velocity / acceleration over the whole
 * flight on one shared time axis, one launch -> apogee -> landing ground track, and
 * the predicted landing point.
 *
 * It does not recompute the ascent: it reads the lifted `flightDynResult` and runs
 * one descent seeded by the ascent's apogee state (apogee altitude, CAD mass, and
 * the lateral velocity at apogee), so the two halves connect. Parachutes, wind and
 * site come from the Recovery config. This is the authoritative end-to-end run, so
 * it can differ from the Recovery tab if that tab uses manual apogee/mass -- stated
 * on screen.
 *
 * Flight events (burnout, apogee, drogue/main deploy) are drawn as vertical guides
 * on the compare plot and as dots on the ground track. Burnout is on the ascent
 * clock (motor burn time); apogee is the handoff; deploy times come from the
 * descent's line-stretch events, shifted onto the glued clock by apogee time.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceDot,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Kind } from '../../lib/units/quantities'
import { runDrift } from '../../recovery/api/client'
import { toWireConfig } from '../../recovery/lib/serialise'
import { useUnits } from '../../lib/units/unitsContext'
import type { DesignSource, DriftResult, UiConfig } from '../../recovery/types/schema'
import type { FlightDynamicsResult } from '../../types'
import type { FlightParams } from '../../types/config'
import {
  AXIS, FD, GRID, REFERENCE, SERIES, TICK_FONT, TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE, axisLabelX, axisLabelY,
} from './chartTheme'
import { Panel, Tile } from './FlightDynamicsTab'

const LANDING = '#ef4444'
const tip = { contentStyle: TOOLTIP_STYLE, labelStyle: TOOLTIP_LABEL_STYLE }

// Event guide colours, distinct from the series line colours AND from the
// ground track's own violet line (FD.drift), which the drogue used to collide
// with -- the drogue is sky, the main pink.
const EV = {
  burnout: '#eab308', // yellow-500
  apogee: REFERENCE, // --color-text-secondary
  drogue: '#38bdf8', // sky-400
  main: '#f472b6', // pink-400
}

/** The whole-flight series that share the compare plot. */
interface FSeries { key: 'altitude' | 'speed' | 'accel' | 'wind'; name: string; kind: Kind; color: string }
const FULL_SERIES: FSeries[] = [
  { key: 'altitude', name: 'Altitude', kind: 'altitude', color: SERIES.altitude },
  { key: 'speed', name: 'Velocity', kind: 'speed', color: SERIES.velocity },
  { key: 'accel', name: 'Acceleration', kind: 'accel', color: SERIES.acceleration },
  { key: 'wind', name: 'Wind', kind: 'speed', color: FD.wind },
]

interface Props {
  result: FlightDynamicsResult | null
  recovery: UiConfig
  design: DesignSource
  /** Launch params, owned by App — carries the persisted compare-plot selection. */
  flight: FlightParams
  onFlightChange: (patch: Partial<FlightParams>) => void
}

export function FullFlightTab({ result, recovery, design, flight, onFlightChange }: Props) {
  const { val, lab, dec, num, dur } = useUnits()
  const [descent, setDescent] = useState<DriftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const seq = useRef(0)
  // Which whole-flight series to overlay on the shared time axis. Persisted on the config
  // (flight.fullCompareSeries) so the selection survives reloads and rides in the save file.
  const compare = useMemo(() => new Set(flight.fullCompareSeries), [flight.fullCompareSeries])
  const toggle = (key: string) => {
    const next = new Set(flight.fullCompareSeries)
    next.has(key) ? next.delete(key) : next.add(key)
    onFlightChange({ fullCompareSeries: [...next] })
  }

  // Descent config: the recovery inputs (parachutes/wind/site) but the vehicle
  // seeded by the ASCENT so the two halves join at apogee.
  const descentConfig = useMemo(() => {
    const base = toWireConfig(recovery)
    if (!result) return base
    return {
      ...base,
      vehicle: {
        ...base.vehicle,
        h_a: result.apogee,
        m: design.massKg ?? base.vehicle.m,
        v_lat: result.lateralVelocityAtApogee,
        v_lat_dir: result.lateralBearingAtApogee,
      },
    }
  }, [recovery, result, design.massKg])

  const cfgKey = JSON.stringify(descentConfig)
  // The airframe bound lives on the config (set on the Drift tab), so Full Flight uses
  // the SAME descent attitude as Recovery — from the save file, not from whether the
  // Drift tab was ever opened. It is a query param, not part of descentConfig, so it is
  // an explicit dependency here.
  const which = recovery.airframeBound
  useEffect(() => {
    if (!result) return
    const mine = ++seq.current
    setRunning(true)
    const id = setTimeout(() => {
      runDrift(descentConfig, which).then((res) => {
        if (mine !== seq.current) return
        setRunning(false)
        if (res.data) { setDescent(res.data); setError(null) }
        else { setError(res.error ?? 'descent failed'); setDescent(null) }
      })
    }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, result, which])

  // --- glued time series (display units) -----------------------------------
  const glued = useMemo(() => {
    if (!result) return { rows: [] as Row[], apogeeT: 0 }
    const rows: Row[] = result.samples.map((s) => ({
      t: s.t,
      altitude: val(s.altitude, 'altitude'),
      speed: val(s.speed, 'speed'),
      accel: val(s.acceleration, 'accel'),
      wind: val(s.windSpeed, 'speed'),   // ambient wind at the rocket's altitude
    }))
    const aT = result.apogeeTime
    if (descent) {
      const tr = descent.track
      for (let i = 0; i < tr.length; i++) {
        const p = tr[i]
        // TOTAL ground speed for the descent = vertical rate + horizontal ground speed
        // (from the track's own x/y). The ascent plots total speed, which at apogee is
        // the lateral/weathercock speed, not zero; plotting the descent's vertical-only
        // rate (0 at apogee) made the velocity dive to 0 at the handoff. Total speed is
        // continuous there — both sides equal the lateral speed at apogee.
        const prev = tr[i - 1] ?? p
        const next = tr[i + 1] ?? p
        const dt = next.t - prev.t
        const hSpeed = dt > 0 ? Math.hypot(next.x - prev.x, next.y - prev.y) / dt : 0
        rows.push({
          t: aT + p.t,
          altitude: val(p.z, 'altitude'),
          speed: val(Math.hypot(Math.abs(p.v), hSpeed), 'speed'),
          accel: val(p.a, 'accel'),
          wind: val(p.wind, 'speed'),           // same ambient-wind curve, on descent
        })
      }
    }
    return { rows, apogeeT: aT }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, descent, lab])

  // --- flight events on the glued clock ------------------------------------
  const events = useMemo(() => {
    if (!result) return [] as EventMark[]
    const evs: EventMark[] = []
    if (result.burnoutTime > 0 && result.burnoutTime < result.apogeeTime)
      evs.push({ t: result.burnoutTime, label: 'burnout', color: EV.burnout })
    evs.push({ t: result.apogeeTime, label: 'apogee', color: EV.apogee })
    if (descent) {
      for (const e of descent.events) {
        if (e.kind !== 'line_stretch') continue
        const dev = (e.device ?? '').toLowerCase()
        const color = dev.includes('main') ? EV.main : EV.drogue
        evs.push({ t: result.apogeeTime + e.t, label: `${cap(e.device ?? 'chute')} deploy`, color })
      }
    }
    return evs
  }, [result, descent])

  // --- glued ground track (display units) ----------------------------------
  const track = useMemo(() => {
    const empty = { pts: [] as Pt[], apogee: null as Pt | null, landing: null as Pt | null,
                    deploys: [] as EventPt[], domainX: [-1, 1] as Dom, domainY: [-1, 1] as Dom }
    if (!result) return empty
    const d = (m: number) => val(m, 'distance')
    const pts: Pt[] = result.samples.map((s) => ({ x: d(s.driftX), y: d(s.driftY) }))
    const last = result.samples.at(-1)
    const aX = last?.driftX ?? 0
    const aY = last?.driftY ?? 0
    const apogee = { x: d(aX), y: d(aY) }
    let landing: Pt | null = null
    const deploys: EventPt[] = []
    if (descent) {
      for (const p of descent.track) pts.push({ x: d(aX + p.x), y: d(aY + p.y) })
      landing = { x: d(aX + descent.landing.x), y: d(aY + descent.landing.y) }
      // Deploy dots: the descent-track sample nearest each line-stretch event.
      for (const e of descent.events) {
        if (e.kind !== 'line_stretch') continue
        let best = descent.track[0]
        for (const p of descent.track) if (Math.abs(p.t - e.t) < Math.abs(best.t - e.t)) best = p
        const dev = (e.device ?? '').toLowerCase()
        deploys.push({
          x: d(aX + best.x), y: d(aY + best.y),
          label: `${cap(e.device ?? 'chute')} deploy`,
          color: dev.includes('main') ? EV.main : EV.drogue,
        })
      }
    }
    // Origin-centered square, like the Flight Dynamics ground track: the pad sits at
    // (0,0) in the middle and the path reads as four quadrants of drift around it —
    // and zoomed in as tight as the trace allows: the half-extent is the farthest point
    // from the pad plus a small margin for the marker labels, NOT snapped up to a round
    // number (which zoomed the track out by up to ~2x). The floor is in DISPLAY units
    // (val(50, 'distance')): 'distance' shows km/mi, so a raw 25 would floor it at 25 km.
    const reach = Math.max(
      val(50, 'distance'),
      ...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))),
    )
    const domainMax = reach * 1.12
    const domainX: Dom = [-domainMax, domainMax]
    const domainY: Dom = [-domainMax, domainMax]
    return { pts, apogee, landing, deploys, domainX, domainY }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, descent, lab])

  // Landing distance / bearing from the pad, in SI, then shown in display units.
  const landingSI = useMemo(() => {
    if (!result || !descent) return null
    const last = result.samples.at(-1)
    const x = (last?.driftX ?? 0) + descent.landing.x
    const y = (last?.driftY ?? 0) + descent.landing.y
    return { x, y, dist: Math.hypot(x, y), bearing: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 }
  }, [result, descent])

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-[var(--color-text-muted)]">
        Run a flight in the <span className="mx-1 font-medium text-[var(--color-text-primary)]">Flight Dynamics</span>
        tab first — the full flight glues that ascent onto the recovery descent.
      </div>
    )
  }

  const showN = (si: number, kind: Kind, digits = 0) => `${num(si, kind, digits)}`
  const selected = FULL_SERIES.filter((d) => compare.has(d.key))
  const yTitle = (d: FSeries) => `${d.name} (${lab(d.kind)})`

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto flex max-w-[1800px] flex-col px-4 py-4 sm:px-6 lg:px-8">
      <div className="mb-2">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">Full flight — launch to landing</h3>
        <p className="text-2xs text-[var(--color-text-muted)]">
          Ascent from Flight Dynamics glued to a recovery descent seeded by it (apogee,
          CAD mass, lateral velocity at apogee). Parachutes, wind and site come from the
          Recovery tab.{running ? ' · updating…' : ''}{error ? ` · ${error}` : ''}
        </p>
      </div>

      {/* Summary tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Apogee" value={showN(result.apogee, 'altitude')} sub={`at ${result.apogeeTime.toFixed(1)} s`} />
        <Tile label="Max velocity" value={showN(result.maxSpeed, 'speed')} sub={`Mach ${result.maxMach.toFixed(2)}`} />
        <Tile label="Total flight" value={descent ? dur(result.apogeeTime + descent.descent_time) : '—'} sub="launch → landing" />
        <Tile label="Descent time" value={descent ? dur(descent.descent_time) : '—'} />
        <Tile label="Landing range" value={landingSI ? showN(landingSI.dist, 'distance') : '—'}
              sub={landingSI ? `bearing ${landingSI.bearing.toFixed(0)}°` : undefined} />
        <Tile label="Impact velocity" value={descent ? showN(Math.abs(descent.track.at(-1)?.v ?? 0), 'speed') : '—'} />
      </div>

      {/* Compare series on one shared time axis */}
      <div className="mb-2">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">Compare series</h3>
        <p className="text-2xs text-[var(--color-text-muted)]">
          Overlay altitude, velocity and acceleration across the whole flight on one time
          axis — each gets its own colored Y axis. Dashed guides mark burnout, apogee and
          each parachute deployment.
        </p>
      </div>
      <div className="mb-5">
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2">
          {FULL_SERIES.map((d) => (
            <label key={d.key} className="flex cursor-pointer items-center gap-1.5 text-xs">
              <input type="checkbox" checked={compare.has(d.key)} onChange={() => toggle(d.key)} style={{ accentColor: d.color }} />
              <span style={{ color: d.color }}>{yTitle(d)}</span>
            </label>
          ))}
        </div>
        <Panel heightClass="h-[460px]"
               hint="Whole flight vs time. Ascent then descent; the vertical guides are burnout, apogee and parachute deployments.">
          {selected.length === 0 ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-xs text-[var(--color-text-muted)]">Select one or more series to plot.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={glued.rows} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
                <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke}
                       tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
                       tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('Time (s)')} />
                {selected.map((d, i) => (
                  <YAxis key={d.key} yAxisId={d.key} orientation={i % 2 === 0 ? 'left' : 'right'}
                         stroke={d.color} tick={{ fontSize: TICK_FONT, fill: d.color }} tickLine={false}
                         width={60} tickFormatter={(v: number) => dec(v, 0)} />
                ))}
                <Tooltip {...tip} labelFormatter={(t: number) => `t = ${dec(t, 1)} s`}
                         formatter={(v: number, n: string) => {
                           const d = FULL_SERIES.find((s) => s.name === n)
                           return [`${dec(v, 1)} ${d ? lab(d.kind) : ''}`, n]
                         }} />
                <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: TICK_FONT, paddingTop: 8 }} />
                {events.map((e) => (
                  <ReferenceLine key={e.label} yAxisId={selected[0].key} x={e.t} stroke={e.color} strokeDasharray="4 3"
                                 label={{ value: e.label, fill: e.color, fontSize: TICK_FONT, position: 'top' }} />
                ))}
                {selected.map((d) => (
                  <Line key={d.key} yAxisId={d.key} type="monotone" dataKey={d.key} name={d.name}
                        stroke={d.color} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      {/* Ground track */}
      <div className="mb-2">
        <h3 className="text-base font-semibold text-[var(--color-text-primary)]">Ground track — launch to landing</h3>
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {/* Square so equal East/North scales read as true distances. */}
        <div className="aspect-square w-full">
          <Panel heightClass="h-full" title="Ground track"
                 hint="Plan view, pad→apogee→landing. The path leaves the pad, arcs over at apogee, then drifts under recovery to the predicted landing; the dots mark each parachute deployment.">
            <FullGroundTrack track={track} lab={lab} dec={dec} />
          </Panel>
        </div>
      </div>
      </div>
    </div>
  )
}

interface Row { t: number; altitude: number; speed: number; accel: number; wind: number }
interface Pt { x: number; y: number }
interface EventMark { t: number; label: string; color: string }
interface EventPt { x: number; y: number; label: string; color: string }
type Dom = [number, number]

/** The combined plan-view path (equal-aspect square framed to the path), marking
 *  launch (origin), apogee (handoff), each deploy, and the predicted landing. */
function FullGroundTrack({ track, lab, dec }: {
  track: { pts: Pt[]; apogee: Pt | null; landing: Pt | null; deploys: EventPt[]; domainX: Dom; domainY: Dom }
  lab: (k: Kind) => string
  dec: (v: number, d: number) => string
}) {
  if (track.pts.length < 2) {
    return <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">No trajectory yet.</div>
  }
  // Symmetric ticks about the pad (…-d, -d/2, 0, d/2, d), like Flight Dynamics.
  const dmax = track.domainX[1]
  const ticks = [-dmax, -dmax / 2, 0, dmax / 2, dmax]
  // Adaptive precision: 'distance' shows km/mi, so a sub-unit scale needs a decimal
  // or every tick rounds to 0.
  const fmt = (v: number) => dec(v, dmax < 2 ? 1 : 0)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={track.pts} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
        <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
        <XAxis type="number" dataKey="x" name="East" domain={track.domainX} ticks={ticks} stroke={AXIS.stroke}
               tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
               tickFormatter={fmt} label={axisLabelX(`East drift (${lab('distance')})`)} />
        <YAxis type="number" dataKey="y" name="North" domain={track.domainY} ticks={ticks} width={64} stroke={AXIS.stroke}
               tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
               tickFormatter={fmt} label={axisLabelY(`North drift (${lab('distance')})`)} />
        <Tooltip {...tip} itemStyle={{ color: '#e2e8f0' }}
                 formatter={(v: number, _n, item: { payload?: { x: number } }) =>
                   [`E ${fmt(item.payload?.x ?? 0)}, N ${fmt(v)} ${lab('distance')}`, 'position']}
                 labelFormatter={() => ''} />
        {/* Quadrant cross through the pad, so drift direction reads at a glance. */}
        <ReferenceLine x={0} stroke={AXIS.stroke} strokeOpacity={0.5} />
        <ReferenceLine y={0} stroke={AXIS.stroke} strokeOpacity={0.5} />
        <Line dataKey="y" type="linear" stroke={FD.drift} strokeWidth={1.75} dot={false} isAnimationActive={false} />
        <ReferenceDot x={0} y={0} r={4} fill={REFERENCE} stroke="none"
                      label={{ value: 'launch', position: 'left', fontSize: TICK_FONT, fill: REFERENCE }} />
        {track.apogee && (
          <ReferenceDot x={track.apogee.x} y={track.apogee.y} r={4} fill={FD.drift} stroke="none"
                        label={{ value: 'apogee', position: 'right', fontSize: TICK_FONT, fill: FD.drift }} />
        )}
        {track.deploys.map((p) => (
          <ReferenceDot key={p.label} x={p.x} y={p.y} r={4} fill={p.color} stroke="none"
                        label={{ value: p.label, position: 'right', fontSize: 11, fill: p.color }} />
        ))}
        {track.landing && (
          <ReferenceDot x={track.landing.x} y={track.landing.y} r={5} fill={LANDING} stroke="none"
                        label={{ value: 'landing', position: 'bottom', fontSize: TICK_FONT, fill: LANDING }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

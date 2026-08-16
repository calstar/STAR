/**
 * Full Flight: the ascent (RocketPy) and the descent (coupled recovery) stitched
 * into one end-to-end picture -- altitude / velocity / acceleration over the whole
 * flight, one launch -> apogee -> landing ground track, and the predicted landing
 * point.
 *
 * It does not recompute the ascent: it reads the lifted `flightDynResult` and runs
 * one descent seeded by the ascent's apogee state (apogee altitude, CAD mass, and
 * the lateral velocity at apogee), so the two halves connect. Parachutes, wind and
 * site come from the Recovery config. This is the authoritative end-to-end run, so
 * it can differ from the Recovery tab if that tab uses manual apogee/mass -- stated
 * on screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Kind } from '../../recovery/lib/quantities'
import { runDrift } from '../../recovery/api/client'
import { toWireConfig } from '../../recovery/lib/serialise'
import { useUnits } from '../../recovery/lib/unitsContext'
import type { DesignSource, DriftResult, UiConfig } from '../../recovery/types/schema'
import type { FlightDynamicsResult } from '../../types'
import {
  AXIS, GRID, REFERENCE, SERIES, TICK_FONT, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE,
  axisLabelX, axisLabelY,
} from './chartTheme'
import { Panel, Tile } from './FlightDynamicsTab'

const LANDING = '#ef4444'
const tip = { contentStyle: TOOLTIP_STYLE, labelStyle: TOOLTIP_LABEL_STYLE }

interface Props {
  result: FlightDynamicsResult | null
  recovery: UiConfig
  design: DesignSource
}

export function FullFlightTab({ result, recovery, design }: Props) {
  const { val, lab, dec, num, dur } = useUnits()
  const [descent, setDescent] = useState<DriftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const seq = useRef(0)

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
  useEffect(() => {
    if (!result) return
    const mine = ++seq.current
    setRunning(true)
    const id = setTimeout(() => {
      runDrift(descentConfig).then((res) => {
        if (mine !== seq.current) return
        setRunning(false)
        if (res.data) { setDescent(res.data); setError(null) }
        else { setError(res.error ?? 'descent failed'); setDescent(null) }
      })
    }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, result])

  // --- glued time series (display units) -----------------------------------
  const flight = useMemo(() => {
    if (!result) return { rows: [] as Row[], apogeeT: 0 }
    const rows: Row[] = result.samples.map((s) => ({
      t: s.t,
      altitude: val(s.altitude, 'altitude'),
      speed: val(s.speed, 'speed'),
      accel: val(s.acceleration, 'accel'),
    }))
    const aT = result.apogeeTime
    if (descent) {
      for (const p of descent.track) {
        rows.push({
          t: aT + p.t,
          altitude: val(p.z, 'altitude'),
          speed: val(Math.abs(p.v), 'speed'),   // vertical descent rate
          accel: val(p.a, 'accel'),
        })
      }
    }
    return { rows, apogeeT: aT }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, descent, lab])

  // --- glued ground track (display units) ----------------------------------
  const track = useMemo(() => {
    if (!result) return { pts: [] as Pt[], apogee: null as Pt | null, landing: null as Pt | null }
    const d = (m: number) => val(m, 'distance')
    const pts: Pt[] = result.samples.map((s) => ({ x: d(s.driftX), y: d(s.driftY) }))
    const last = result.samples.at(-1)
    const aX = last?.driftX ?? 0
    const aY = last?.driftY ?? 0
    const apogee = { x: d(aX), y: d(aY) }
    let landing: Pt | null = null
    if (descent) {
      for (const p of descent.track) pts.push({ x: d(aX + p.x), y: d(aY + p.y) })
      landing = { x: d(aX + descent.landing.x), y: d(aY + descent.landing.y) }
    }
    return { pts, apogee, landing }
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
      <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-400">
        Run a flight in the <span className="mx-1 font-semibold text-slate-200">Flight Dynamics</span>
        tab first — the full flight glues that ascent onto the recovery descent.
      </div>
    )
  }

  const showN = (si: number, kind: Kind, digits = 0) => `${num(si, kind, digits)}`

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-950 p-4">
      <div className="mb-2">
        <h3 className="text-base font-semibold text-slate-100">Full flight — launch to landing</h3>
        <p className="text-2xs text-slate-400">
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

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Altitude" hint="Whole flight vs time; the dashed line is apogee (ascent→descent handoff).">
          {timeChart(flight.rows, 'altitude', 'altitude', SERIES.altitude, flight.apogeeT, lab, dec)}
        </Panel>
        <Panel title="Velocity" hint="Ascent speed, then the vertical descent rate under the canopies.">
          {timeChart(flight.rows, 'speed', 'speed', SERIES.velocity, flight.apogeeT, lab, dec)}
        </Panel>
        <Panel title="Acceleration" hint="Boost, coast, then the deployment decelerations.">
          {timeChart(flight.rows, 'accel', 'accel', SERIES.acceleration, flight.apogeeT, lab, dec)}
        </Panel>

        <Panel title="Ground track — launch to landing"
               hint="Plan view. The path leaves the pad, arcs over at apogee, then drifts under recovery to the predicted landing.">
          <FullGroundTrack track={track} lab={lab} dec={dec} />
        </Panel>
      </div>
    </div>
  )
}

interface Row { t: number; altitude: number; speed: number; accel: number }
interface Pt { x: number; y: number }

/** One glued time-series (data already in display units), with the apogee marker. */
function timeChart(
  rows: Row[], dataKey: keyof Row, kind: Kind, color: string, apogeeT: number,
  lab: (k: Kind) => string, dec: (v: number, d: number) => string,
) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
        <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
        <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke}
               tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
               tickFormatter={(v: number) => v.toFixed(0)} label={axisLabelX('Time (s)')} />
        <YAxis stroke={color} tick={{ fontSize: TICK_FONT, fill: color }} tickLine={false}
               width={64} label={axisLabelY(`${cap(String(dataKey))} (${lab(kind)})`)} />
        <Tooltip {...tip} labelFormatter={(t: number) => `t = ${dec(t, 1)} s`}
                 formatter={(v: number) => [`${dec(v, 1)} ${lab(kind)}`, cap(String(dataKey))]} />
        <ReferenceLine x={apogeeT} stroke={REFERENCE} strokeDasharray="4 3"
                       label={{ value: 'apogee', fill: REFERENCE, fontSize: TICK_FONT, position: 'top' }} />
        <Line type="monotone" dataKey={dataKey} stroke={color} dot={false}
              strokeWidth={1.75} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/** The combined plan-view path (equal-aspect square, pad at origin), marking
 *  launch (origin), apogee (handoff) and the predicted landing. */
function FullGroundTrack({ track, lab, dec }: {
  track: { pts: Pt[]; apogee: Pt | null; landing: Pt | null }
  lab: (k: Kind) => string
  dec: (v: number, d: number) => string
}) {
  if (track.pts.length < 2) {
    return <div className="flex h-full items-center justify-center text-xs text-slate-400">No trajectory yet.</div>
  }
  const reach = Math.max(...track.pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))))
  const R = Math.max(reach * 1.15, 50)
  const fmt = (v: number) => dec(v, 0)
  return (
    <div className="mx-auto aspect-square h-full max-h-[30rem] w-full max-w-[30rem]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={track.pts} margin={{ top: 8, right: 16, bottom: 30, left: 8 }}>
          <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
          <XAxis type="number" dataKey="x" domain={[-R, R]} stroke={AXIS.stroke}
                 tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
                 tickFormatter={fmt} allowDecimals={false} label={axisLabelX(`East (${lab('distance')})`)} />
          <YAxis type="number" domain={[-R, R]} width={56} stroke={AXIS.stroke}
                 tick={{ fontSize: TICK_FONT, fill: AXIS.stroke }} tickLine={false}
                 tickFormatter={fmt} allowDecimals={false} label={axisLabelY(`North (${lab('distance')})`)} />
          <Tooltip {...tip} formatter={(v: number, n: string) => [`${fmt(v)} ${lab('distance')}`, n === 'y' ? 'north' : n]}
                   labelFormatter={(x: number) => `East ${fmt(x)} ${lab('distance')}`} />
          <ReferenceLine x={0} stroke="#4b5563" />
          <ReferenceLine y={0} stroke="#4b5563" />
          <Line dataKey="y" type="linear" stroke={SERIES.altitude} strokeWidth={2} dot={false} isAnimationActive={false} />
          <ReferenceDot x={0} y={0} r={4} fill="#f8fafc" stroke="none"
                        label={{ value: 'launch', position: 'left', fontSize: 12, fill: '#cbd5e1' }} />
          {track.apogee && (
            <ReferenceDot x={track.apogee.x} y={track.apogee.y} r={4} fill={REFERENCE} stroke="none"
                          label={{ value: 'apogee', position: 'top', fontSize: 12, fill: REFERENCE }} />
          )}
          {track.landing && (
            <ReferenceDot x={track.landing.x} y={track.landing.y} r={5} fill={LANDING} stroke="none"
                          label={{ value: 'landing', position: 'bottom', fontSize: 12, fill: LANDING }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

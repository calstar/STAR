/**
 * Flight Dynamics tab: a 6-DOF ascent (RocketPy) driven by the CAD rocket.
 *
 * Ascent only (rail -> apogee); descent/recovery is the recovery calculator's job.
 * Aero uses RocketPy's native surfaces; the stability panel overlays our CP(M) margin
 * against RocketPy's for comparison (the "CP model" selector picks which curve(s) show).
 * Drag and inertia are approximations (see FUTURE_IMPROVEMENTS.md) -- stability panels are
 * exact, performance tiles (apogee, max-Q) are flagged approximate.
 */

import { useState } from 'react'
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'

import { computeFlightDynamics } from '../../api/client'
import type { FaceRef, FlightDynamicsResult, MotorSelection } from '../../types'
import { AXIS, FD, GRID, REFERENCE, SERIES, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './chartTheme'

interface Props {
  modelId: string | null
  motorSel: MotorSelection | null
  outerFaces: FaceRef[]
  finFaces: FaceRef[]
  nFins: number
  railLength: number
  overrides: Record<string, number>
}

type CpModel = 'ours' | 'rocketpy' | 'both'
const G = 9.80665

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${warn ? 'border-rose-500/40 bg-rose-500/10' : 'border-slate-700 bg-slate-900/60'}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${warn ? 'text-rose-300' : 'text-slate-100'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[240px] flex-col rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="mb-1">
        <div className="text-sm font-semibold text-slate-200">{title}</div>
        <div className="text-[11px] leading-tight text-slate-500">{hint}</div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

const tip = { contentStyle: TOOLTIP_STYLE, labelStyle: TOOLTIP_LABEL_STYLE }

/** A single-series line vs time, with shared axis styling. */
function TimeLine({
  data,
  yKey,
  color,
  name,
  unit,
  fmt = (v: number) => v.toFixed(0),
}: {
  data: object[]
  yKey: string
  color: string
  name: string
  unit: string
  fmt?: (v: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
        <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
        <YAxis stroke={color} tick={{ fontSize: 11, fill: color }} tickLine={false} width={46} tickFormatter={fmt} />
        <Tooltip {...tip} formatter={(v: number) => [`${fmt(v)} ${unit}`, name]} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} />
        <Line type="monotone" dataKey={yKey} name={name} stroke={color} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function FlightDynamicsTab({ modelId, motorSel, outerFaces, finFaces, nFins, railLength, overrides }: Props) {
  const [inclination, setInclination] = useState(85)
  const [heading, setHeading] = useState(0)
  const [windSpeed, setWindSpeed] = useState(5)
  const [windDirection, setWindDirection] = useState(270)
  const [elevation, setElevation] = useState(1400)
  const [cpModel, setCpModel] = useState<CpModel>('both')

  const [result, setResult] = useState<FlightDynamicsResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        elevation,
      })
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const samples = result?.samples ?? []
  const track = samples.map((s) => ({ x: s.driftX, y: s.driftY }))
  const apogeePt = track.at(-1)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-950 p-4">
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
        <Field label="Rail incl. (°)" value={inclination} set={setInclination} min={0} max={90} />
        <Field label="Heading (°)" value={heading} set={setHeading} min={0} max={360} />
        <Field label="Wind (m/s)" value={windSpeed} set={setWindSpeed} min={0} max={40} step={0.5} />
        <Field label="Wind from (°)" value={windDirection} set={setWindDirection} min={0} max={360} />
        <Field label="Elevation (m)" value={elevation} set={setElevation} min={0} max={4000} step={10} />
        <label className="flex flex-col text-xs text-slate-400">
          CP model
          <select value={cpModel} onChange={(e) => setCpModel(e.target.value as CpModel)} className="mt-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100">
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

          {/* Panels */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel title="Ground track" hint="Top-down path of the horizontal displacement, pad→apogee. Shows which way — and how far — the wind throws it.">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                  <XAxis type="number" dataKey="x" name="East" stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
                  <YAxis type="number" dataKey="y" name="North" stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} width={44} tickFormatter={(v: number) => v.toFixed(0)} />
                  <ZAxis range={[8, 8]} />
                  <Tooltip {...tip} formatter={(v: number, n: string) => [`${v.toFixed(0)} m`, n]} />
                  <Scatter data={track} line={{ stroke: FD.drift, strokeWidth: 1.75 }} fill={FD.drift} isAnimationActive={false} />
                  <ReferenceDot x={0} y={0} r={4} fill={REFERENCE} stroke="none" label={{ value: 'pad', fill: REFERENCE, fontSize: 11, position: 'left' }} />
                  {apogeePt && <ReferenceDot x={apogeePt.x} y={apogeePt.y} r={4} fill={FD.drift} stroke="none" label={{ value: 'apogee', fill: FD.drift, fontSize: 11, position: 'right' }} />}
                </ScatterChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Altitude · velocity · acceleration" hint="The core performance profile vs time, now with real drag (apogee is drag-limited, not an upper bound).">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={samples} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                  <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
                  <YAxis yAxisId="alt" stroke={SERIES.altitude} tick={{ fontSize: 11, fill: SERIES.altitude }} tickLine={false} width={46} />
                  <YAxis yAxisId="vel" orientation="right" stroke={SERIES.velocity} tick={{ fontSize: 11, fill: SERIES.velocity }} tickLine={false} width={44} />
                  <Tooltip {...tip} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line yAxisId="alt" type="monotone" dataKey="altitude" name="Altitude (m)" stroke={SERIES.altitude} dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line yAxisId="vel" type="monotone" dataKey="speed" name="Speed (m/s)" stroke={SERIES.velocity} dot={false} strokeWidth={1.75} isAnimationActive={false} />
                  <Line yAxisId="vel" type="monotone" dataKey="acceleration" name="Accel (m/s²)" stroke={SERIES.acceleration} dot={false} strokeWidth={1.25} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Dynamic pressure (max-Q)" hint="Aerodynamic load on the airframe. The peak (max-Q) is the ascent structural driver — the airframe/fins see the most stress here.">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={samples} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                  <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
                  <YAxis stroke={FD.pressure} tick={{ fontSize: 11, fill: FD.pressure }} tickLine={false} width={46} tickFormatter={(v: number) => (v / 1000).toFixed(0)} />
                  <Tooltip {...tip} formatter={(v: number) => [`${(v / 1000).toFixed(2)} kPa`, 'q']} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} />
                  <ReferenceLine x={result.maxDynamicPressureTime} stroke={REFERENCE} strokeDasharray="4 3" label={{ value: 'max-Q', fill: REFERENCE, fontSize: 11, position: 'top' }} />
                  <Line type="monotone" dataKey="dynamicPressure" name="q" stroke={FD.pressure} dot={false} strokeWidth={1.75} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Mach" hint="Compressibility regime vs time — the transonic band is where CP migrates and the margin is tightest (see stability panel).">
              <TimeLine data={samples} yKey="mach" color={FD.mach} name="Mach" unit="" fmt={(v) => v.toFixed(2)} />
            </Panel>

            <Panel title="Stability margin — ours vs RocketPy" hint="Static margin (calibers) through flight. Ours migrates the fin CP with Mach; RocketPy holds it fixed. Below 1 cal (dashed) is marginal.">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={samples} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                  <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} />
                  <YAxis stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} width={40} tickFormatter={(v: number) => v.toFixed(1)} />
                  <Tooltip {...tip} formatter={(v: number, n: string) => [`${v.toFixed(2)} cal`, n]} labelFormatter={(t: number) => `t = ${t.toFixed(2)} s`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={1} stroke={REFERENCE} strokeDasharray="2 2" />
                  <ReferenceLine y={0} stroke="#f43f5e" strokeDasharray="2 2" />
                  {(cpModel === 'ours' || cpModel === 'both') && (
                    <Line type="monotone" dataKey="stabilityMarginOurs" name="Ours (CP↑Mach)" stroke={FD.marginOurs} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
                  )}
                  {(cpModel === 'rocketpy' || cpModel === 'both') && (
                    <Line type="monotone" dataKey="stabilityMarginRocketpy" name="RocketPy (CP fixed)" stroke={FD.marginRocketpy} dot={false} strokeWidth={1.75} strokeDasharray="5 3" isAnimationActive={false} connectNulls />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Angle of attack" hint="Weathercocking response to wind. High AoA off the rail is an instability risk; pairs with the off-rail margin tile. Null near apogee (airspeed→0).">
              <TimeLine data={samples} yKey="angleOfAttack" color={FD.aoa} name="AoA" unit="°" fmt={(v) => v.toFixed(1)} />
            </Panel>

            <Panel title="Aerodynamic bending moment" hint="Structural load along the airframe on ascent — peak bending sizes the airframe and the fin can. Complements the recovery calculator's descent loads.">
              <TimeLine data={samples} yKey="bendingMoment" color={FD.bending} name="Bending" unit="N·m" fmt={(v) => v.toFixed(1)} />
            </Panel>

            <Panel title="Pitch rate & frequency response" hint="Dynamic stability: the pitch angular rate over time, and the FFT of attitude — its peak is the oscillation frequency, how fast it settles after a gust.">
              <div className="grid h-full grid-cols-2 gap-2">
                <TimeLine data={samples} yKey="omegaPitch" color={FD.omega} name="ω pitch" unit="rad/s" fmt={(v) => v.toFixed(2)} />
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={result.fft.frequency.map((f, i) => ({ f, a: result.fft.amplitude[i] }))} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                    <XAxis dataKey="f" type="number" domain={[0, 20]} stroke={AXIS.stroke} tick={{ fontSize: 11, fill: AXIS.stroke }} tickLine={false} tickFormatter={(v: number) => v.toFixed(0)} label={{ value: 'Hz', fill: AXIS.stroke, fontSize: 10, position: 'insideBottomRight' }} />
                    <YAxis stroke={FD.fft} tick={{ fontSize: 11, fill: FD.fft }} tickLine={false} width={36} />
                    <Tooltip {...tip} formatter={(v: number) => [v.toFixed(3), 'amp']} labelFormatter={(f: number) => `${f.toFixed(2)} Hz`} />
                    <Line type="monotone" dataKey="a" name="attitude FFT" stroke={FD.fft} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="mt-3 rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
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
    <label className="flex flex-col text-xs text-slate-400">
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

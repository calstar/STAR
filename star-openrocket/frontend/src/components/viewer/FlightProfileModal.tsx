/**
 * Flight-profile popup: altitude, velocity, acceleration and static margin over time on one
 * OpenRocket-style overlay chart (shared time axis, multiple y-axes), plus summary tiles.
 *
 * The sim (backend aero/flight.py) has no drag yet, so apogee is an upper bound — the footer
 * says so. Recovery/descent is out of scope (the recovery calculator owns that).
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { FlightResult } from '../../types'
import {
  AXIS,
  GRID,
  REFERENCE,
  REFERENCE_RAIL,
  SERIES,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './chartTheme'

interface Props {
  result: FlightResult | null
  busy: boolean
  error: string | null
  onClose: () => void
}

const G = 9.80665

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-slate-700 bg-slate-800/60 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-base font-semibold tabular-nums text-slate-100">{value}</div>
      {sub && <div className="text-2xs text-slate-500">{sub}</div>}
    </div>
  )
}

export function FlightProfileModal({ result, busy, error, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(940px,96vh)] w-[min(1500px,97vw)] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-100">
            Flight profile{result ? ` — ${result.motor.name}` : ''}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
          >
            Close
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {busy && <p className="text-sm text-slate-400">Simulating flight…</p>}
          {error && <p className="text-sm text-rose-400">{error}</p>}

          {result && !busy && !error && (
            <>
              {!result.liftoff && (
                <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  Insufficient thrust to lift off — peak thrust-to-weight is{' '}
                  {result.thrustToWeight.toFixed(2)} (needs &gt; 1). The rocket stays on the pad.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
                <Tile label="Apogee" value={`${result.apogee.toFixed(0)} m`} sub={`at ${result.apogeeTime.toFixed(1)} s`} />
                <Tile label="Max velocity" value={`${result.maxVelocity.toFixed(0)} m/s`} sub={`Mach ${(result.maxVelocity / 340.29).toFixed(2)}`} />
                <Tile label="Max accel" value={`${(result.maxAcceleration / G).toFixed(1)} g`} sub={`${result.maxAcceleration.toFixed(0)} m/s²`} />
                <Tile
                  label="Off-rail velocity"
                  value={result.railCleared && result.railExitVelocity != null ? `${result.railExitVelocity.toFixed(1)} m/s` : '—'}
                  sub={result.railCleared ? `${result.railLength.toFixed(2)} m rail` : `rail > apogee`}
                />
                <Tile label="Burnout" value={`${result.burnoutTime.toFixed(2)} s`} sub={`${result.burnoutAltitude.toFixed(0)} m · ${result.burnoutVelocity.toFixed(0)} m/s`} />
                <Tile label="Thrust-to-weight" value={result.thrustToWeight.toFixed(1)} />
                <Tile
                  label="Min margin"
                  value={result.minStaticMargin != null ? `${result.minStaticMargin.toFixed(2)} cal` : '—'}
                  sub={result.minMarginMach != null ? `at Mach ${result.minMarginMach.toFixed(2)}` : 'no fins'}
                />
              </div>

              <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={result.samples} margin={{ top: 44, right: 56, bottom: 8, left: 8 }}>
                    <CartesianGrid stroke={GRID.stroke} strokeDasharray={GRID.strokeDasharray} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={[0, 'dataMax']}
                      stroke={AXIS.stroke}
                      tick={{ fontSize: AXIS.fontSize, fill: AXIS.stroke }}
                      tickLine={AXIS.tickLine}
                      tickFormatter={(v: number) => v.toFixed(1)}
                    />
                    {/* Four y-axes, OpenRocket-style: altitude + margin on the left, velocity +
                        acceleration on the right. Units/names live in the legend below. */}
                    <YAxis yAxisId="alt" stroke={SERIES.altitude} tick={{ fontSize: 11, fill: SERIES.altitude }} tickLine={false} width={48} />
                    <YAxis yAxisId="margin" orientation="left" stroke={SERIES.margin} tick={{ fontSize: 11, fill: SERIES.margin }} tickLine={false} width={40} tickFormatter={(v: number) => v.toFixed(1)} />
                    <YAxis yAxisId="vel" orientation="right" stroke={SERIES.velocity} tick={{ fontSize: 11, fill: SERIES.velocity }} tickLine={false} width={48} />
                    <YAxis yAxisId="acc" orientation="right" stroke={SERIES.acceleration} tick={{ fontSize: 11, fill: SERIES.acceleration }} tickLine={false} width={44} />

                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      labelFormatter={(v: number) => `t = ${Number(v).toFixed(2)} s`}
                      formatter={(value: number, name: string) => [Number(value).toFixed(2), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />

                    <ReferenceLine yAxisId="margin" y={0} stroke="#f43f5e" strokeDasharray="2 2" />
                    {result.railCleared && result.railExitTime != null && (
                      <ReferenceLine yAxisId="alt" x={result.railExitTime} stroke={REFERENCE_RAIL} strokeDasharray="4 3" label={{ value: 'rail', fill: REFERENCE_RAIL, fontSize: 13, fontWeight: 600, position: 'top', dy: -8 }} />
                    )}
                    <ReferenceLine yAxisId="alt" x={result.burnoutTime} stroke={REFERENCE} strokeWidth={1.5} strokeDasharray="4 3" label={{ value: 'burnout', fill: REFERENCE, fontSize: 13, fontWeight: 600, position: 'top', dy: -8 }} />
                    <ReferenceLine yAxisId="alt" x={result.apogeeTime} stroke={REFERENCE} strokeWidth={1.5} strokeDasharray="4 3" label={{ value: 'apogee', fill: REFERENCE, fontSize: 13, fontWeight: 600, position: 'top', dy: -8 }} />

                    <Line yAxisId="alt" type="monotone" dataKey="altitude" name="Altitude (m)" stroke={SERIES.altitude} dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line yAxisId="vel" type="monotone" dataKey="velocity" name="Velocity (m/s)" stroke={SERIES.velocity} dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line yAxisId="acc" type="monotone" dataKey="acceleration" name="Acceleration (m/s²)" stroke={SERIES.acceleration} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                    <Line yAxisId="margin" type="monotone" dataKey="staticMargin" name="Static margin (cal)" stroke={SERIES.margin} dot={false} strokeWidth={1.5} strokeDasharray="5 3" isAnimationActive={false} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <p className="text-2xs text-slate-500">
                Drag is not modelled yet — apogee and peak velocity are upper bounds. Static margin
                walks from the wet value at ignition to the dry value at burnout. Descent is handled
                by the recovery calculator.
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

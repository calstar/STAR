/**
 * Motor curves popup: thrust, total weight, and CG position over time for the selected motor's
 * datafile — the raw thrustcurve.org data behind the flight sim, on one overlay chart.
 *
 * CG is measured from the motor's forward (fore) end, the same convention OpenRocket uses.
 * Full (RockSim) datafiles carry real per-sample mass/CG; Basic (RASP) back-compute the mass
 * and pin CG to length/2 — so a flat CG line means a Basic datafile.
 */

import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { MotorDetail } from '../../types'
import { AXIS, GRID, SERIES, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './chartTheme'

interface Props {
  detail: MotorDetail | null
  /** Which datafile to plot; falls back to the first if not found. */
  simfileId: string | null
  busy: boolean
  error: string | null
  onClose: () => void
}

export function MotorCurvesModal({ detail, simfileId, busy, error, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sim = useMemo(() => {
    if (!detail) return null
    return detail.simfiles.find((s) => s.simfileId === simfileId) ?? detail.simfiles[0] ?? null
  }, [detail, simfileId])

  const data = useMemo(() => {
    if (!sim) return []
    const n = Math.min(sim.time.length, sim.thrust.length, sim.mass.length, sim.cgX.length)
    return Array.from({ length: n }, (_, i) => ({
      t: sim.time[i],
      thrust: sim.thrust[i],
      massG: sim.mass[i] * 1000, // kg -> g
      cgMm: sim.cgX[i] * 1000, // m -> mm from the fore end
    }))
  }, [sim])

  const title = sim ? `${sim.manufacturer} ${sim.designation}` : 'Motor curves'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(760px,92vh)] w-[min(1200px,96vw)] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-100">Motor curves — {title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
          >
            Close
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {busy && <p className="text-sm text-slate-400">Loading motor data…</p>}
          {error && <p className="text-sm text-rose-400">{error}</p>}

          {sim && !busy && !error && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Tile label="Wet / dry" value={`${(sim.wetMass * 1000).toFixed(1)} / ${(sim.dryMass * 1000).toFixed(1)} g`} />
                <Tile label="Propellant" value={`${(sim.propMass * 1000).toFixed(1)} g`} />
                <Tile label="Burn time" value={`${sim.burnTime.toFixed(2)} s`} />
              </div>

              <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data} margin={{ top: 12, right: 48, bottom: 8, left: 8 }}>
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
                    <YAxis yAxisId="thrust" stroke={SERIES.acceleration} tick={{ fontSize: 11, fill: SERIES.acceleration }} tickLine={false} width={48} />
                    <YAxis yAxisId="mass" orientation="right" stroke={SERIES.velocity} tick={{ fontSize: 11, fill: SERIES.velocity }} tickLine={false} width={52} />
                    <YAxis yAxisId="cg" orientation="right" stroke={SERIES.altitude} tick={{ fontSize: 11, fill: SERIES.altitude }} tickLine={false} width={48} />

                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      labelFormatter={(v: number) => `t = ${Number(v).toFixed(2)} s`}
                      formatter={(value: number, name: string) => [Number(value).toFixed(2), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />

                    <Line yAxisId="thrust" type="monotone" dataKey="thrust" name="Thrust (N)" stroke={SERIES.acceleration} dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line yAxisId="mass" type="monotone" dataKey="massG" name="Weight (g)" stroke={SERIES.velocity} dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line yAxisId="cg" type="monotone" dataKey="cgMm" name="CG from fore end (mm)" stroke={SERIES.altitude} dot={false} strokeWidth={1.5} strokeDasharray="5 3" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-700 bg-slate-800/60 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-base font-semibold tabular-nums text-slate-100">{value}</div>
    </div>
  )
}

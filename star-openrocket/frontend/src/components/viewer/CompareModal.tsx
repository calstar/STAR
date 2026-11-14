/**
 * Compare the open model with another, side by side -- the check that a CAD model
 * and an OpenRocket .ork describe the same rocket.
 *
 * Every number comes from POST /api/compare (backend/ork/compare.py), which measures
 * both models with the same code and flags each row that differs beyond what a
 * build can resolve; this only lays the rows out in the user's units.
 *
 * The open model is compared as the panel has it -- its chosen surfaces, mass
 * overrides and motor. The other is auto-detected, and flies its own motor when it
 * is an .ork that names one (at the .ork's placement), else the same motor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { compareModels, fetchManifest } from '../../api/client'
import { useUnits } from '../../lib/units/unitsContext'
import type { CompareRow, CompareSide, ModelSummary, MotorSelection } from '../../types'

interface Props {
  models: ModelSummary[]
  current: CompareSide
  onClose: () => void
}

function label(model: ModelSummary | undefined): string {
  if (!model) return '—'
  return `${model.documentName ?? model.id}${model.kind === 'ork' ? ' (OpenRocket)' : ''}`
}

export function CompareModal({ models, current, onClose }: Props) {
  const { q, lab } = useUnits()
  const others = useMemo(() => models.filter((m) => m.id !== current.modelId), [models, current.modelId])
  const currentKind = models.find((m) => m.id === current.modelId)?.kind ?? 'onshape'
  // Default to the first model of the other kind: a CAD build wants its .ork.
  const [otherId, setOtherId] = useState<string | null>(
    () => (others.find((m) => (m.kind ?? 'onshape') !== currentKind) ?? others[0])?.id ?? null,
  )
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = useCallback(async (id: string) => {
    setBusy(true)
    setError(null)
    setRows(null)
    try {
      const manifest = await fetchManifest(id)
      const orkMotor = manifest.ork?.motors.find((m) => m.default && m.motorId) ?? null
      const motor: MotorSelection | null | undefined = orkMotor?.motorId
        ? { motorId: orkMotor.motorId, simfileId: orkMotor.simfileId, aftOffset: orkMotor.aftOffset, state: 'launch' }
        : current.motor
          ? { ...current.motor, refFace: null }
          : null
      const result = await compareModels(current, { modelId: id, motor })
      setRows(result.rows)
    } catch (exc) {
      setError(String(exc))
    } finally {
      setBusy(false)
    }
  }, [current])

  useEffect(() => {
    if (otherId) void run(otherId)
  }, [otherId, run])

  const show = (row: CompareRow, value: number | null): string => {
    if (value === null) return '—'
    if (row.kind === 'count') return value.toFixed(0)
    if (row.kind === 'margin') return `${value.toFixed(2)} cal`
    return q(value, row.kind)
  }
  const showDelta = (row: CompareRow): string => {
    if (row.delta === null) return '—'
    const sign = row.delta > 0 ? '+' : ''
    if (row.kind === 'count') return `${sign}${row.delta.toFixed(0)}`
    if (row.kind === 'margin') return `${sign}${row.delta.toFixed(2)} cal`
    return `${sign}${q(row.delta, row.kind)}`
  }
  const differing = rows?.filter((r) => r.differs).length ?? 0
  const thisModel = models.find((m) => m.id === current.modelId)
  const otherModel = models.find((m) => m.id === otherId)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-[min(900px,96vw)] flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-medium text-[var(--color-text-primary)]">Compare models</h2>
          <span className="text-xs text-[var(--color-text-muted)]">{label(thisModel)} against</span>
          <select
            value={otherId ?? ''}
            onChange={(e) => setOtherId(e.target.value || null)}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          >
            {others.length === 0 && <option value="">No other model — import an .ork from the picker</option>}
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {label(m)} {m.assemblyName ? `· ${m.assemblyName}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3">
          {busy && <p className="text-xs text-[var(--color-text-muted)]">Measuring both models…</p>}
          {error && <p className="rounded bg-rose-500/15 px-2 py-1 text-xs text-rose-300">{error}</p>}
          {rows && (
            <>
              <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                {differing === 0
                  ? 'Every row agrees within what a build can resolve.'
                  : `${differing} of ${rows.length} rows differ (highlighted). Lengths in ${lab('length')}, diameters and fins in ${lab('smallLength')}.`}
              </p>
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-left text-[var(--color-text-muted)]">
                    <th className="py-1 font-normal">Quantity</th>
                    <th className="py-1 text-right font-normal">{label(thisModel)}</th>
                    <th className="py-1 text-right font-normal">{label(otherModel)}</th>
                    <th className="py-1 text-right font-normal">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.key}
                      className={`border-t border-[var(--color-border)] ${row.differs ? 'bg-amber-500/10 text-amber-200' : 'text-[var(--color-text-primary)]'}`}
                    >
                      <td className="py-1 pr-2">{row.label}</td>
                      <td className="py-1 text-right">{show(row, row.a)}</td>
                      <td className="py-1 text-right">{show(row, row.b)}</td>
                      <td className="py-1 text-right">{showDelta(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

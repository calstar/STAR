/**
 * Centre-of-pressure and static-margin readout.
 *
 * Everything shown here is computed by the backend (aero/stability.py), which is
 * the single source of truth for CG, CoP and margin -- the frontend only asks and
 * renders. The CoP (body + fins) matches OpenRocket's static (Mach 0.3, AoA 0)
 * Barrowman result; an optional motor folds its wet/dry mass into the CG and
 * static margin, placed along the detected axis.
 */

import { useState } from 'react'

import type { MotorSelection, MotorSummary, StabilityResult } from '../../types'
import { MotorPicker } from './MotorPicker'
import { Row } from './Row'

interface Props {
  result: StabilityResult | null
  busy: boolean
  error: string | null
  onCompute: () => void
  /** Face editing: pick/correct which faces are the airframe / the fins. */
  faceEditMode: boolean
  editTarget: 'body' | 'fin'
  onToggleEditMode: (target: 'body' | 'fin') => void
  onAutoDetect: () => void
  outerFaceCount: number
  finFaceCount: number
  finCount: number
  autoBusy: boolean
  isolate: boolean
  onToggleIsolate: () => void
  /** Motor selection (folds into CG / static margin). */
  motorSel: MotorSelection | null
  motorSummary: MotorSummary | null
  onSelectMotor: (motor: MotorSummary, simfileId: string) => void
  onClearMotor: () => void
  onSetMotorState: (state: 'launch' | 'burnout') => void
  onSetMotorAft: (aftFromNose: number | null) => void
}

function formatMargin(margin: number | null): string {
  if (margin === null) return '—'
  return `${margin.toFixed(2)} cal`
}

function marginTone(margin: number | null): string {
  if (margin === null) return 'text-slate-100'
  if (margin >= 1) return 'text-emerald-300'
  if (margin > 0) return 'text-amber-300'
  return 'text-rose-400'
}

/** The chosen datafile's format, for labelling before a compute round-trips. */
function selectedFormat(
  motor: MotorSummary | null,
  simfileId: string | null | undefined,
): 'RASP' | 'RockSim' | undefined {
  if (!motor) return undefined
  const sim = motor.simfiles.find((s) => s.simfileId === simfileId) ?? motor.simfiles[0]
  return sim?.format
}

/** RockSim = "Full model", RASP = "Basic model" (see MotorPicker). */
function MotorTierBadge({ format }: { format: 'RASP' | 'RockSim' | undefined }) {
  if (!format) return null
  const full = format === 'RockSim'
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        full ? 'bg-emerald-900 text-emerald-300' : 'bg-slate-700 text-slate-300'
      }`}
      title={format}
    >
      {full ? 'Full model' : 'Basic model'}
    </span>
  )
}

export function StabilityPanel({
  result,
  busy,
  error,
  onCompute,
  faceEditMode,
  onToggleEditMode,
  onAutoDetect,
  outerFaceCount,
  finFaceCount,
  finCount,
  autoBusy,
  isolate,
  onToggleIsolate,
  editTarget,
  motorSel,
  motorSummary,
  onSelectMotor,
  onClearMotor,
  onSetMotorState,
  onSetMotorAft,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <section className="pointer-events-auto rounded border border-slate-700 bg-slate-900/90 p-3 text-sm backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Stability
        </h2>
        <button
          type="button"
          onClick={onCompute}
          disabled={busy}
          className="rounded bg-cyan-600 px-2 py-1 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {busy ? 'Computing…' : result ? 'Recompute' : 'Compute'}
        </button>
      </div>

      {/* Surface controls: auto-detect seeds both sets; the edit buttons let the
          user click faces to correct the body (teal) or fins (orange). */}
      <div className="mb-2 flex items-center gap-2 border-b border-slate-700 pb-2">
        <button
          type="button"
          onClick={() => onToggleEditMode('body')}
          className={`rounded px-2 py-1 text-xs font-medium ${
            faceEditMode && editTarget === 'body'
              ? 'bg-violet-500 text-white'
              : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          Body ({outerFaceCount})
        </button>
        <button
          type="button"
          onClick={() => onToggleEditMode('fin')}
          className={`rounded px-2 py-1 text-xs font-medium ${
            faceEditMode && editTarget === 'fin'
              ? 'bg-orange-500 text-white'
              : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          Fins ({finCount})
        </button>
        <button
          type="button"
          onClick={onAutoDetect}
          disabled={autoBusy}
          className="ml-auto rounded bg-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-50"
        >
          {autoBusy ? 'Detecting…' : 'Auto-detect'}
        </button>
      </div>

      <p className="mb-2 text-xs text-slate-400">
        {finCount > 0
          ? `${finCount} fin${finCount === 1 ? '' : 's'} detected · ${finFaceCount} fin face${finFaceCount === 1 ? '' : 's'} selected`
          : 'No fins detected yet — Auto-detect or select them.'}
      </p>

      {faceEditMode && (
        <p className={`mb-2 text-xs ${editTarget === 'fin' ? 'text-orange-300' : 'text-violet-300'}`}>
          Click faces to add/remove them from the {editTarget === 'fin' ? 'fins' : 'body'}; click
          the same button again to stop, then Recompute.
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleIsolate}
          disabled={outerFaceCount === 0}
          className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-40 ${
            isolate ? 'bg-cyan-500 text-white' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          {isolate ? 'Show all surfaces' : 'Isolate used surfaces'}
        </button>
        <span className="text-xs text-slate-400">
          {isolate ? 'showing only the CP surfaces' : ''}
        </span>
      </div>

      {/* Motor: folds into the CG / static margin as a placed mass. */}
      <div className="mb-2 border-t border-slate-700 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Motor
          </span>
          {motorSel ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600"
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => {
                  onClearMotor()
                  setPickerOpen(false)
                }}
                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600"
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600"
            >
              {pickerOpen ? 'Cancel' : 'Add motor'}
            </button>
          )}
        </div>

        {pickerOpen && (
          <div className="mb-2">
            <MotorPicker
              onSelect={(motor, simfileId) => {
                onSelectMotor(motor, simfileId)
                setPickerOpen(false)
              }}
              onClose={() => setPickerOpen(false)}
            />
          </div>
        )}

        {motorSel && (
          <>
            <div className="mb-1 flex items-center gap-2">
              <span className="truncate text-sm text-slate-100">
                {result?.motor?.name ??
                  (motorSummary
                    ? `${motorSummary.manufacturerAbbrev} ${motorSummary.designation}`
                    : motorSel.motorId)}
              </span>
              <MotorTierBadge
                format={result?.motor?.format ?? selectedFormat(motorSummary, motorSel.simfileId)}
              />
            </div>

            {/* Wet vs dry: which end of the mass table to place. */}
            <div className="mb-2 flex overflow-hidden rounded border border-slate-700 text-xs">
              {(['launch', 'burnout'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSetMotorState(s)}
                  className={`flex-1 px-2 py-1 ${
                    motorSel.state === s
                      ? 'bg-cyan-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {s === 'launch' ? 'Wet (launch)' : 'Dry (burnout)'}
                </button>
              ))}
            </div>

            <label className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
              Aft position from nose
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  step={1}
                  value={
                    motorSel.aftFromNose != null
                      ? Math.round(motorSel.aftFromNose * 1000)
                      : ''
                  }
                  placeholder={
                    result ? Math.round(result.bodyLength * 1000).toString() : 'aft-flush'
                  }
                  onChange={(e) => {
                    const v = e.target.value.trim()
                    onSetMotorAft(v === '' ? null : Number(v) / 1000)
                  }}
                  className="w-20 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-right text-slate-100 focus:border-cyan-500 focus:outline-none"
                />
                <span className="text-slate-500">mm</span>
              </span>
            </label>
            {motorSel.aftFromNose == null && (
              <p className="mb-2 text-[11px] text-slate-500">
                Empty = aft-flush with the airframe base.
              </p>
            )}

            {result?.motor && (
              <>
                <Row
                  label="Motor mass"
                  value={`${(
                    (result.motor.state === 'burnout'
                      ? result.motor.dryMass
                      : result.motor.wetMass) * 1000
                  ).toFixed(1)} g`}
                  small
                />
                <Row
                  label="Wet / dry"
                  value={`${(result.motor.wetMass * 1000).toFixed(1)} / ${(
                    result.motor.dryMass * 1000
                  ).toFixed(1)} g`}
                  small
                />
                {result.motor.cgFromNose != null && (
                  <Row
                    label="Motor CG from nose"
                    value={`${result.motor.cgFromNose.toFixed(4)} m`}
                    small
                  />
                )}
                <Row
                  label="Motor L × D"
                  value={`${(result.motor.length * 1000).toFixed(0)} × ${(
                    result.motor.diameter * 1000
                  ).toFixed(0)} mm`}
                  small
                />
              </>
            )}
          </>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

      {!result && !error && (
        <p className="text-xs text-slate-400">
          Auto-detects the outer airframe and computes CoP, CG and static margin
          from the CAD, matching OpenRocket, including fins. Add a motor to fold
          its wet/dry mass into the CG and margin.
        </p>
      )}

      {result && (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-slate-400">Static margin</span>
            <span className={`text-lg font-semibold tabular-nums ${marginTone(result.staticMargin)}`}>
              {formatMargin(result.staticMargin)}
            </span>
          </div>
          <Row label="CoP from nose" value={`${result.cp.fromNose.toFixed(4)} m`} highlight />
          <Row label="CG from nose" value={`${result.cg.fromNose.toFixed(4)} m`} />
          <Row label="Body length" value={`${result.bodyLength.toFixed(4)} m`} small />
          <Row label="Ref diameter" value={`${(result.refDiameter * 1000).toFixed(1)} mm`} small />
          <Row label="CNₐ (total)" value={result.cna.toFixed(3)} small />
          <Row label="Mass" value={`${result.mass.toFixed(4)} kg`} small />

          <div className="mt-2 border-t border-slate-700 pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Fins
              </span>
              <span className="text-xs text-slate-300">
                {result.fins.count > 0 ? `${result.fins.count} detected` : 'none detected'}
              </span>
            </div>
            {result.fins.count > 0 && (
              <>
                <Row label="Fin area (each)" value={`${(result.fins.area * 1e4).toFixed(1)} cm²`} small />
                <Row label="Root chord" value={`${(result.fins.rootChord * 1000).toFixed(1)} mm`} small />
                <Row label="Tip chord" value={`${(result.fins.tipChord * 1000).toFixed(1)} mm`} small />
                <Row label="Span" value={`${(result.fins.span * 1000).toFixed(1)} mm`} small />
                <Row label="Sweep" value={`${(result.fins.sweep * 1000).toFixed(1)} mm`} small />
                <Row label="CNₐ (fins)" value={result.fins.cna.toFixed(3)} small />
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Centre-of-pressure and static-margin readout.
 *
 * Everything shown here is computed by the backend (aero/stability.py), which is
 * the single source of truth for CG, CP and margin -- the frontend only asks and
 * renders. The CP (body + fins) matches OpenRocket's static (Mach 0.3, AoA 0)
 * Barrowman result; an optional motor folds its wet/dry mass into the CG and
 * static margin, placed along the detected axis.
 */

import { useDisabled } from '@stardesign-ui'
import { useState } from 'react'

import type { FaceRef, MotorSelection, MotorSummary, StabilityResult } from '../../types'
import { useUnits } from '../../lib/units/unitsContext'
import type { Kind } from '../../lib/units/quantities'
import { MotorPicker } from './MotorPicker'
import { Row } from './Row'

/**
 * A number input in the chosen unit that stores SI. Mirrors the recovery
 * UnitInput's editing/display split (full precision while focused, the bounded
 * form when blurred) so typing a fractional value never fights the formatter,
 * but keeps the viewer's slate styling. Commits SI on every change.
 */
function UnitField({ value, onChange, kind, min }: {
  value: number
  onChange: (si: number) => void
  kind: Kind
  min?: number
}) {
  const { val, si, forInput, u } = useUnits()
  // Every use of this writes a design field (motor aft offset, rail length), so
  // it goes read-only with the design rather than each call site remembering.
  const disabled = useDisabled()
  const [editing, setEditing] = useState(false)
  const shown = editing ? val(value, kind) : forInput(value, kind)
  return (
    <input
      type="number"
      step={u(kind).step}
      min={min}
      disabled={disabled}
      value={shown}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      onChange={(e) => {
        const t = e.target.value.trim()
        onChange(t === '' ? 0 : si(Number(t), kind))
      }}
      className="w-20 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-right text-slate-100 focus:border-cyan-500 focus:outline-none disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
    />
  )
}

export interface StabilityPanelProps {
  result: StabilityResult | null
  /** Static margin recomputed client-side from live mass edits (CP is fixed). Falls back to
   *  the backend value when absent. */
  liveMargin?: number | null
  liveCgFromNose?: number | null
  busy: boolean
  error: string | null
  onCompute: () => void
  /** Face editing: pick/correct which faces are the airframe / the fins. */
  faceEditMode: boolean
  editTarget: 'body' | 'fin' | 'motor'
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
  /** Aft-end offset from the datum (base or reference face), metres, aft-positive. */
  onSetMotorOffset: (aftOffset: number) => void
  onSetMotorRefFace: (refFace: FaceRef | null) => void
  /** True while clicks are picking the motor's reference face. */
  motorFaceEdit: boolean
  onToggleMotorFaceEdit: () => void
  /** Open the flight-profile popup (enabled once a motor is folded into a computed result). */
  onViewFlight: () => void
  /** Guided rail length (m) for the flight sim's off-rail velocity. */
  railLength: number
  onSetRailLength: (m: number) => void
  /** Open the motor-curves popup (thrust / weight / CG over time) for the selected motor. */
  onViewMotorCurves: () => void
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

export function StabilityPanel({
  result,
  liveMargin,
  liveCgFromNose,
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
  onSetMotorOffset,
  onSetMotorRefFace,
  motorFaceEdit,
  onToggleMotorFaceEdit,
  onViewFlight,
  railLength,
  onSetRailLength,
  onViewMotorCurves,
}: StabilityPanelProps) {
  const { q, lab, num } = useUnits()
  // Face sets, the motor and its placement, and the rail length are all part of
  // the design, so they need the checkout. Computing stability, isolating a
  // surface and opening the flight/curve popups only look at it, and stay live.
  const readOnly = useDisabled()
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <div className="text-sm">
      {/* ── Surface detection: approve the airframe + fin faces, then compute ── */}
      <section className="border-b border-slate-800 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
          Surface Detection
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
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggleEditMode('body')}
          disabled={readOnly}
          className={`rounded px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
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
          disabled={readOnly}
          className={`rounded px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
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
          disabled={autoBusy || readOnly}
          className="ml-auto rounded bg-slate-700 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-50"
        >
          {autoBusy ? 'Detecting…' : 'Auto-detect'}
        </button>
      </div>

      <p className="mb-2 text-xs text-slate-400">
        {finCount > 0
          ? `${finCount} fin${finCount === 1 ? '' : 's'} detected · ${finFaceCount} potential fin face${finFaceCount === 1 ? '' : 's'}`
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

      {/* Airframe dimensions from the detected surface, shown once computed. */}
      {result && (
        <div className="mt-2 border-t border-slate-700 pt-2">
          <Row label="Body length" value={q(result.bodyLength, 'length')} small />
          <Row label="Ref diameter" value={q(result.refDiameter, 'length')} small />
        </div>
      )}

      {/* Fins geometry (feeds the CP), shown once computed. */}
      {result && (
        <div className="mt-2 border-t border-slate-700 pt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wide text-slate-200">
              Fins
            </span>
            <span className="text-xs text-slate-300">
              {result.fins.count > 0 ? `${result.fins.count} detected` : 'none detected'}
            </span>
          </div>
          {result.fins.count > 0 && (
            <>
              <Row label="Fin area (each)" value={q(result.fins.area, 'area')} small />
              <Row label="Root chord" value={q(result.fins.rootChord, 'length')} small />
              <Row label="Tip chord" value={q(result.fins.tipChord, 'length')} small />
              <Row label="Span" value={q(result.fins.span, 'length')} small />
              <Row label="Sweep" value={q(result.fins.sweep, 'length')} small />
              <Row label="CNₐ (fins)" value={result.fins.cna.toFixed(3)} small />
            </>
          )}
        </div>
      )}
      </section>

      {/* ── Motor: folds into the CG / static margin as a placed mass ── */}
      <section className="border-b border-slate-800 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-200">
            Motor
          </span>
          {motorSel ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onViewMotorCurves}
                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600"
                title="Thrust, weight and CG over time"
              >
                Curves
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={readOnly}
                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => {
                  onClearMotor()
                  setPickerOpen(false)
                }}
                disabled={readOnly}
                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={readOnly}
              className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
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
            </div>

            {/* Wet vs dry: which end of the mass table to place. */}
            <div className="mb-2 flex overflow-hidden rounded border border-slate-700 text-xs">
              {(['launch', 'burnout'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSetMotorState(s)}
                  disabled={readOnly}
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

            {/* Placement datum: the airframe aft end by default, or a picked face
                (enforced normal to the axis by the backend). */}
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              <span>Placement datum</span>
              <span className="flex items-center gap-1">
                {motorSel.refFace ? (
                  <>
                    <span className="rounded bg-fuchsia-900 px-1.5 py-0.5 text-2xs font-medium text-fuchsia-200">
                      face
                    </span>
                    <button
                      type="button"
                      onClick={() => onSetMotorRefFace(null)}
                      disabled={readOnly}
                      className="rounded bg-slate-700 px-1.5 py-0.5 text-2xs text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <span className="text-slate-500">airframe base (aft)</span>
                )}
                <button
                  type="button"
                  onClick={onToggleMotorFaceEdit}
                  disabled={readOnly}
                  className={`rounded px-1.5 py-0.5 text-2xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                    motorFaceEdit
                      ? 'bg-fuchsia-600 text-white'
                      : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                  }`}
                >
                  {motorFaceEdit ? 'Picking…' : 'Pick face'}
                </button>
              </span>
            </div>
            {motorFaceEdit && (
              <p className="mb-1 text-2xs text-fuchsia-300">
                Click a face square to the body axis; a slanted face is rejected. Click the
                same face again to clear.
              </p>
            )}

            <label className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              {motorSel.refFace ? 'Aft offset from face' : 'Aft offset from base'}
              <span className="flex items-center gap-1">
                <UnitField value={motorSel.aftOffset ?? 0} onChange={onSetMotorOffset} kind="length" />
                <span className="text-slate-500">{lab('length')}</span>
              </span>
            </label>

            {result?.motor && (
              <>
                <Row
                  label="Motor wet / dry mass"
                  value={`${num(result.motor.wetMass, 'mass')} / ${q(result.motor.dryMass, 'mass')}`}
                  small
                />
                <Row
                  label="Motor L × D"
                  value={`${num(result.motor.length, 'length')} × ${q(result.motor.diameter, 'length')}`}
                  small
                />
              </>
            )}
          </>
        )}
      </section>

      {/* ── Stability results ── */}
      <section className="border-b border-slate-800 p-3">
        <div className="mb-2 flex items-center">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-200">
            Stability
          </span>
        </div>

        {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

        {!result && !error && (
          <p className="text-xs text-slate-400">
            Auto-detects the outer airframe and computes CP, CG and static margin from the
            CAD, matching OpenRocket, including fins. Add a motor to fold its wet/dry mass into
            the CG and margin.
          </p>
        )}

        {result && (
          <>
            {(() => {
              // CP is fixed by geometry; CG (and so the margin) tracks live mass edits.
              const margin = liveMargin ?? result.staticMargin
              const cgFromNose = liveCgFromNose ?? result.cg.fromNose
              return (
                <>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-slate-400">Static margin</span>
                    <span className={`text-lg font-semibold tabular-nums ${marginTone(margin)}`}>
                      {formatMargin(margin)}
                    </span>
                  </div>
                  <Row label="CP from nose" value={q(result.cp.fromNose, 'length')} />
                  <Row label="CG from nose" value={q(cgFromNose, 'length')} />
                </>
              )
            })()}
            <Row label="CNₐ (total)" value={result.cna.toFixed(3)} small />
            {result.fins.count > 0 && !result.fins.symmetric && (
              <p className="mt-2 border-t border-slate-700 pt-2 text-xs text-amber-300">
                ⚠ Fins are not azimuthally symmetric — the true CP sits off the axis and this
                axial model under-states the instability. Expected {result.fins.count === 1 ? 'a single fin' : `${result.fins.count} uneven fins`}; check the fin selection.
              </p>
            )}
            {(() => {
              // Total loaded mass at each end of the burn: the CAD mass plus the motor's wet or
              // dry mass. `result.mass` already includes the motor at the selected state, so back
              // out that state's mass to recover the CAD-only mass.
              const sel = result.motor
                ? result.motor.state === 'burnout'
                  ? result.motor.dryMass
                  : result.motor.wetMass
                : 0
              const cad = result.mass - sel
              const wet = cad + (result.motor?.wetMass ?? 0)
              const dry = cad + (result.motor?.dryMass ?? 0)
              return (
                <Row
                  label="Total wet / dry mass"
                  value={`${num(wet, 'mass')} / ${q(dry, 'mass')}`}
                  small
                />
              )
            })()}
          </>
        )}
      </section>

      {/* ── Flight profile: needs a motor folded into the computed result ── */}
      {result && (
        <section className="p-3">
          <div className="mb-2 flex items-center">
            <span className="text-sm font-semibold uppercase tracking-wide text-slate-200">
              Flight Profile
            </span>
          </div>
          <label className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
            Guided rail length
            <span className="flex items-center gap-1">
              <UnitField
                value={railLength}
                onChange={(m) => onSetRailLength(Number.isFinite(m) && m >= 0 ? m : 0)}
                kind="length"
                min={0}
              />
              <span className="text-slate-500">{lab('length')}</span>
            </span>
          </label>
          <button
            type="button"
            onClick={onViewFlight}
            disabled={!result.motor}
            className="w-full rounded bg-cyan-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            View flight profile
          </button>
          {!result.motor && (
            <p className="mt-1 text-2xs text-slate-500">Add a motor to simulate the ascent.</p>
          )}
        </section>
      )}
    </div>
  )
}

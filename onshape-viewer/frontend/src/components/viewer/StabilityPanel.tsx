/**
 * Centre-of-pressure and static-margin readout.
 *
 * Everything shown here is computed by the backend (aero/stability.py), which is
 * the single source of truth for CG, CoP and margin -- the frontend only asks and
 * renders. The body-of-revolution CoP matches OpenRocket's static (Mach 0.3,
 * AoA 0) Barrowman result; fins are not yet included, which the panel says
 * plainly so a margin is never read as final before they are.
 */

import type { StabilityResult } from '../../types'
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
}: Props) {
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

      {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

      {!result && !error && (
        <p className="text-xs text-slate-400">
          Auto-detects the outer airframe and computes CoP, CG and static margin
          from the CAD, matching OpenRocket. Fins are not yet included.
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

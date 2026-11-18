/**
 * The ORK vs CAD tab: the CAD tab's stability result next to the OpenRocket tab's
 * design, parameter by parameter.
 *
 * Neither side is computed here. CAD is the last Compute in the CAD tab; ORK is
 * whatever the OpenRocket tab has open, analysed by openrocket-web's port of
 * OpenRocket 24.12 at the CAD's Mach (0.3, AoA 0). The rows, the pairing of
 * with-motor against with-motor, and the thresholds are lib/orkCompare.ts.
 *
 * Nothing on this tab edits the design: "Load CAD into OpenRocket" replaces the
 * OpenRocket tab's document (which is not part of the design), and Compute is the
 * CAD tab's own button, gated the same way.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Analysis, RocketDocument, WorkbenchState } from '@openrocket-web'

import { analyzeOrk } from '../../api/client'
import { COMPARE_MACH, cadSide, compareRows, orkSide, type Row, type Severity } from '../../lib/orkCompare'
import { useUnits } from '../../lib/units/unitsContext'
import { Badge, Button, Card } from '../../recovery/components/ui'
import type { StabilityResult } from '../../types'
import { formatCell, formatDelta, formatPct } from './format'

export interface OrkVsCadTabProps {
  modelId: string | null
  stability: StabilityResult | null
  /** True when part masses changed since the last Compute (the CAD column is then old). */
  stabilityStale: boolean
  stabilityBusy: boolean
  stabilityError: string | null
  onComputeStability: () => void
  /** What the OpenRocket tab has open; null until it has connected. */
  ork: WorkbenchState | null
  onLoadCadIntoOrk: () => void
  loadBusy: boolean
  loadError: string | null
}

const SEVERITY_ROW: Record<Severity, string> = {
  ok: '',
  na: '',
  warn: 'bg-amber-500/10',
  bad: 'bg-red-500/15',
}
const SEVERITY_TEXT: Record<Severity, string> = {
  ok: 'text-[var(--color-text-secondary)]',
  na: 'text-[var(--color-text-muted)]',
  warn: 'text-amber-300',
  bad: 'text-red-300 font-semibold',
}

/** ORK's analysis at the CAD's conditions: the workbench's own when it already is, else asked for. */
function useOrkAnalysisAtCompareMach(doc: RocketDocument | null, own: Analysis | null) {
  const [state, setState] = useState<{ analysis: Analysis | null; error: string | null; doc: RocketDocument | null }>({
    analysis: null,
    error: null,
    doc: null,
  })
  const ownMatches =
    own != null &&
    doc != null &&
    own.conditions.mach === COMPARE_MACH &&
    own.conditions.aoaDeg === 0 &&
    (own.conditions.configId ?? null) === (doc.selectedConfig ?? null)
  useEffect(() => {
    if (!doc || ownMatches) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      analyzeOrk(doc, { mach: COMPARE_MACH, aoaDeg: 0, rollRate: 0, theta: 0, configId: doc.selectedConfig }, ctl.signal)
        .then((analysis) => setState({ analysis, error: null, doc }))
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name !== 'AbortError') setState({ analysis: null, error: String((e as Error)?.message ?? e), doc })
        })
    }, 150)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [doc, ownMatches])
  if (ownMatches) return { analysis: own, error: null }
  if (state.doc !== doc) return { analysis: null, error: null }
  return { analysis: state.analysis, error: state.error }
}

export function OrkVsCadTab(props: OrkVsCadTabProps) {
  const { modelId, stability, stabilityStale, stabilityBusy, stabilityError, onComputeStability, ork, onLoadCadIntoOrk, loadBusy, loadError } = props
  const units = useUnits()
  const doc = ork?.document ?? null
  const { analysis, error: orkError } = useOrkAnalysisAtCompareMach(doc, ork?.analysis ?? null)

  const cad = useMemo(() => (stability ? cadSide(stability) : null), [stability])
  const orkS = useMemo(() => (doc && analysis ? orkSide(doc, analysis) : null), [doc, analysis])
  const rows = useMemo(() => compareRows(cad, orkS), [cad, orkS])
  const notes = [...(cad?.notes ?? []).map((n) => `CAD: ${n}`), ...(orkS?.notes ?? []).map((n) => `ORK: ${n}`)]
  const flagged = rows.filter((r) => r.severity === 'bad' || r.severity === 'warn').length

  const motorName = (() => {
    if (!doc) return null
    const cfg = doc.motorConfigs.find((c) => c.id === doc.selectedConfig)
    const motors = cfg ? Object.values(cfg.motors) : []
    return motors.length ? motors.map((m) => `${m.manufacturer ?? ''} ${m.designation}`.trim()).join(' + ') : null
  })()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg-primary)]" data-testid="ork-vs-cad">
      <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <Card
          title="ORK vs CAD"
          subtitle={`The CAD tab's stability (Onshape geometry, mesh Barrowman) against the OpenRocket tab's design (OpenRocket 24.12, ported), both at Mach ${COMPARE_MACH}, α 0°. Δ is ORK − CAD; Δ % is of the CAD value.`}
          right={
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                action
                variant="primary"
                onClick={onLoadCadIntoOrk}
                disabled={!modelId || loadBusy}
                title="Export the CAD as an .ork (the same file as Export .ork) and open it in the OpenRocket tab, replacing what is there"
              >
                {loadBusy ? 'Loading…' : 'Load CAD into OpenRocket tab'}
              </Button>
              <Button onClick={onComputeStability} disabled={!modelId || stabilityBusy} title="Run the CAD tab's stability Compute">
                {stabilityBusy ? 'Computing…' : stability ? 'Recompute CAD' : 'Compute CAD stability'}
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="font-medium text-[var(--color-text-primary)]">CAD</span>
            {!modelId ? (
              <Badge tone="warning">no model</Badge>
            ) : stability ? (
              <>
                <Badge tone={stabilityStale ? 'warning' : 'success'}>{stabilityStale ? 'masses changed since Compute' : 'computed'}</Badge>
                <span>{stability.motor ? `motor ${stability.motor.name} (${stability.motor.state})` : 'no motor'}</span>
              </>
            ) : (
              <Badge tone="warning">not computed</Badge>
            )}
            <span className="mx-2 h-4 w-px bg-[var(--color-border)]" />
            <span className="font-medium text-[var(--color-text-primary)]">ORK</span>
            {!doc ? (
              <Badge tone="warning">{ork === null ? 'connecting' : 'no design'}</Badge>
            ) : (
              <>
                <span>{doc.rocket.name || 'Rocket'}</span>
                <span>{motorName ? `motor ${motorName}` : 'no motor'}</span>
                {orkError ? <Badge tone="danger">analysis failed</Badge> : !analysis ? <Badge>analysing…</Badge> : null}
              </>
            )}
            {flagged > 0 && (
              <Badge tone="danger" title="Rows past the highlight thresholds (see the footnote)">
                {flagged} differ
              </Badge>
            )}
          </div>

          {stabilityError && <p className="mt-2 text-xs text-red-300">CAD: {stabilityError}</p>}
          {loadError && <p className="mt-2 text-xs text-red-300">Load CAD into OpenRocket: {loadError}</p>}
          {orkError && <p className="mt-2 text-xs text-red-300">ORK: {orkError}</p>}
          {!stability && modelId && !stabilityBusy && (
            <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
              The CAD column needs a stability result. Press Compute CAD stability (or Compute in the CAD tab's Analysis panel).
              Computing needs the design checked out, as it does there.
            </p>
          )}
          {!modelId && (
            <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
              No CAD model is selected; pick or build one in the header to fill the CAD column.
            </p>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  <th className="py-2 pr-4 font-medium">Parameter</th>
                  <th className="py-2 pr-4 text-right font-medium">CAD (Onshape)</th>
                  <th className="py-2 pr-4 text-right font-medium">ORK (OpenRocket)</th>
                  <th className="py-2 pr-4 text-right font-medium">Δ</th>
                  <th className="py-2 text-right font-medium">Δ %</th>
                </tr>
              </thead>
              <tbody className="font-num">
                {rows.map((r) => (
                  <ComparisonRow key={r.id} row={r} units={units} />
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-4 space-y-1 text-xs text-[var(--color-text-muted)]">
            <li>
              Highlighted: sizes and masses ≥ 2 % apart (amber) or ≥ 5 % (red); static margin ≥ 0.1 cal (amber) or ≥ 0.25 cal (red);
              fin count when it differs. Each margin is on its own side's reference diameter.
            </li>
            <li>
              Empty rows are each side without its motor; with-motor rows are each side with its motor at launch, and are
              compared only when both sides have one -- a loaded CG is never set against an empty one.
            </li>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function ComparisonRow({ row, units }: { row: Row; units: ReturnType<typeof useUnits> }) {
  const cadText = row.unit === 'text' ? (row.cadText ?? '—') : formatCell(row.cad, row.unit, units)
  const orkText = row.unit === 'text' ? (row.orkText ?? '—') : formatCell(row.ork, row.unit, units)
  return (
    <tr className={`border-b border-[var(--color-border)]/60 ${SEVERITY_ROW[row.severity]}`} data-severity={row.severity}>
      <td className="py-1.5 pr-4 text-[var(--color-text-primary)]">
        {row.label}
        {row.hint && <span className="ml-2 text-xs text-[var(--color-text-muted)]">({row.hint})</span>}
      </td>
      <td className="py-1.5 pr-4 text-right">{cadText}</td>
      <td className="py-1.5 pr-4 text-right">{orkText}</td>
      <td className={`py-1.5 pr-4 text-right ${SEVERITY_TEXT[row.severity]}`}>{formatDelta(row.delta, row.unit, units)}</td>
      <td className={`py-1.5 text-right ${SEVERITY_TEXT[row.severity]}`}>{formatPct(row.deltaPct)}</td>
    </tr>
  )
}

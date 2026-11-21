/**
 * The lower half of every tab (OpenRocket's RocketPanel): the control ribbon
 * (View Type, Zoom, Stability/Show CG/CP, Stages, Flight configuration -- plus
 * Mach and angle of attack, which OpenRocket keeps in its preferences), the
 * roll-rotation column, the figure, and the hint line with "Show warnings".
 */
import { useState } from 'react'
import type { Analysis, Conditions, RocketDocument } from '../types'
import { Check, Combo, Spinner, VSlider } from './swing'
import { RocketFigure, fitPercent, PX_PER_M_AT_100, type View } from './RocketFigure'
import { AnalysisTable } from './AnalysisTable'
import { useSize } from '../workbench/hooks'
import { pix } from '../workbench/icons'
import { configLabel } from '../workbench/configs'
import { isStageActive, stageButtonEnabled, stageList } from '../lib/flightconfig'

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5]

export function RocketPanel({
  doc, analysis, selectedId, onSelect, onEdit, conditions, setConditions, onSelectConfig, onToggleStage, provenance, mockMode, error,
}: {
  doc: RocketDocument
  analysis: Analysis | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onEdit: (id: string) => void
  conditions: Conditions
  setConditions: (c: Conditions) => void
  onSelectConfig: (id: string) => void
  /** Flip a stage's activeness in the selected configuration (FlightConfiguration.toggleStage). */
  onToggleStage?: (stageNumber: number) => void
  provenance: string
  mockMode: boolean
  error: string | null
}) {
  const [view, setView] = useState<View>({ zoom: null, cx: null, cy: null })
  const [showCgCp, setShowCgCp] = useState(true)
  const [showWarnings, setShowWarnings] = useState(true)
  const [showTable, setShowTable] = useState(false)
  const [figRef, figSize] = useSize<HTMLDivElement>()
  const fit = fitPercent(analysis, figSize.w, figSize.h)
  const zoomPct = view.zoom == null ? fit : view.zoom * 100
  // StageSelector: one toggle per stage, bound to the selected configuration's stage flags.
  const stages = stageList(doc)
  const cfg = doc.motorConfigs.find((c) => c.id === doc.selectedConfig) ?? null
  const rotDeg = Math.round((conditions.theta * 180) / Math.PI)

  const zoomBy = (f: number) => setView({ ...view, zoom: Math.min(50, Math.max(0.05, (zoomPct / 100) * f)) })

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 6px' }}>
      {/* ribbon */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 0, flex: 'none', height: 58, paddingBottom: 6 }}>
        <Labeled label="View Type:" width={174}>
          <Combo
            value="side"
            onChange={() => {}}
            style={{ width: 124 }}
            options={[
              { value: 'side', label: 'Side view' },
              { value: 'back', label: 'Back view', disabled: true },
              { value: '3d', label: '3D Figure', disabled: true },
              { value: '3df', label: '3D Finished', disabled: true },
              { value: '3du', label: '3D Unfinished', disabled: true },
            ]}
            title="Side view only in this milestone"
          />
        </Labeled>
        <Labeled label="Zoom:" width={163}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconBtn icon="icons/zoom-out.png" title="Zoom out" onClick={() => zoomBy(1 / 1.5)} />
            <select
              className="orw-field"
              style={{ width: 106 }}
              value={view.zoom == null ? 'fit' : String(view.zoom)}
              onChange={(e) => setView(e.target.value === 'fit' ? { zoom: null, cx: null, cy: null } : { ...view, zoom: Number(e.target.value) })}
              aria-label="Zoom"
            >
              <option value="fit">Fit ({fit.toFixed(1)}%)</option>
              {view.zoom != null && !ZOOMS.includes(view.zoom) && <option value={String(view.zoom)}>{(view.zoom * 100).toFixed(1)}%</option>}
              {ZOOMS.map((z) => (
                <option key={z} value={String(z)}>
                  {z * 100}%
                </option>
              ))}
            </select>
            <IconBtn icon="icons/zoom-in.png" title="Zoom in" onClick={() => zoomBy(1.5)} />
          </span>
        </Labeled>
        <Labeled label="Stability:" width={130}>
          <Check label="Show CG/CP" checked={showCgCp} onChange={setShowCgCp} title="Disabling this checkbox hides the CG and CP markings in the rocket view." />
        </Labeled>
        <div style={{ width: 1, alignSelf: 'stretch', margin: '12px 24px 2px 0', background: '#d0d0d0' }} />
        <Labeled label="Stages:" width={Math.max(120, stages.length * 92)}>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {stages.map(({ stage: s, number }) => {
              const active = isStageActive(cfg ?? undefined, number)
              const enabled = !!cfg && stageButtonEnabled(doc, cfg, number)
              return (
                <button
                  type="button"
                  key={s.id}
                  className="orw-btn"
                  aria-pressed={active}
                  disabled={!enabled}
                  data-testid={`stage-toggle-${number}`}
                  onClick={() => onToggleStage?.(number)}
                  style={{
                    padding: '0 14px',
                    ...(active ? { background: '#dedede', borderColor: '#cecece' } : {}),
                    ...(!enabled ? { color: '#959595', fontStyle: 'italic' } : {}),
                  }}
                  title={
                    s.children.length === 0
                      ? 'This stage does not have child components and is therefore marked as inactive. Add components to the stage to activate it.'
                      : enabled
                        ? 'Toggle this button to activate/deactivate the stage.'
                        : 'Cannot deactivate the only active stage.'
                  }
                >
                  {s.name}
                </button>
              )
            })}
          </span>
        </Labeled>
        <Labeled label="Mach:" width={170}>
          <Spinner
            value={conditions.mach}
            min={0}
            max={5}
            step={0.05}
            width={64}
            slider={[0, 2]}
            sliderWidth={80}
            onChange={(m) => setConditions({ ...conditions, mach: Math.round(m * 1000) / 1000 })}
            ariaLabel="Mach"
          />
        </Labeled>
        <Labeled label="Angle of attack:" width={160}>
          <Spinner
            value={(conditions.aoaDeg * Math.PI) / 180}
            kind="angle"
            min={-Math.PI / 2}
            max={Math.PI / 2}
            width={64}
            onChange={(r) => setConditions({ ...conditions, aoaDeg: Math.round(((r * 180) / Math.PI) * 100) / 100 })}
            ariaLabel="Angle of attack"
          />
        </Labeled>
        <div style={{ flex: 1 }} />
        <Labeled label="Flight configuration:" width={228} last>
          <select
            className="orw-field"
            style={{ width: 228 }}
            value={doc.selectedConfig ?? ''}
            onChange={(e) => onSelectConfig(e.target.value)}
            aria-label="Flight configuration"
          >
            {doc.motorConfigs.map((c) => (
              <option key={c.id} value={c.id}>
                {configLabel(doc, c)}
              </option>
            ))}
          </select>
        </Labeled>
      </div>

      {/* rotation column + figure */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 6 }}>
        <div style={{ width: 60, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center' }} title="Change the rocket's roll rotation (only affects the rocket view)">
            <input
              className="orw-field"
              style={{ width: 50, height: 21, textAlign: 'right' }}
              value={rotDeg}
              aria-label="Rotation"
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setConditions({ ...conditions, theta: (v * Math.PI) / 180 })
              }}
            />
            <span style={{ fontSize: 11, marginLeft: 2, alignSelf: 'flex-start' }}>°</span>
          </span>
          <VSlider
            value={rotDeg}
            min={0}
            max={360}
            onChange={(v) => setConditions({ ...conditions, theta: (Math.round(v) * Math.PI) / 180 })}
            ariaLabel="Rotation slider"
            style={{ flex: 1, marginTop: 8, marginBottom: 12 }}
          />
          <img src={pix('icons/unlocked.png')} alt="" title="Lock/unlock click-drag rotation" style={{ width: 22, height: 22, border: '1px solid #ccc', borderRadius: 3, padding: 2, background: 'white' }} />
        </div>
        <div ref={figRef} style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          <RocketFigure
            doc={doc}
            analysis={analysis}
            selectedId={selectedId}
            onSelect={onSelect}
            onEdit={onEdit}
            view={view}
            setView={setView}
            showCgCp={showCgCp}
            showWarnings={showWarnings}
            configLabel={cfg ? configLabel(doc, cfg) : '[No motors]'}
            provenance={provenance}
          />
        </div>
      </div>

      {showTable && (
        <div style={{ flex: 'none', height: 170, marginTop: 6, marginLeft: 66, border: '1px solid #c0c0c0', background: 'white', overflow: 'auto' }}>
          <AnalysisTable doc={doc} analysis={analysis} selectedId={selectedId} onSelect={onSelect} provenance={provenance} />
        </div>
      )}

      {/* hint line */}
      <div style={{ flex: 'none', height: 30, display: 'flex', alignItems: 'center', paddingLeft: 91 }}>
        <span className="orw-hint">
          Click to select&nbsp;&nbsp;&nbsp; Shift+click to select other&nbsp;&nbsp;&nbsp; Double-click to edit&nbsp;&nbsp;&nbsp; Click+drag to move
        </span>
        <span
          className="orw-hint"
          style={{ marginLeft: 24, color: '#2b5f99', cursor: 'default', textDecoration: 'underline dotted' }}
          onClick={() => setShowTable((s) => !s)}
          data-testid="toggle-analysis"
        >
          {showTable ? '▾' : '▸'} Component analysis
        </span>
        {mockMode && (
          <span className="orw-banner" title="The backend (port 8004) did not answer; numbers come from an approximate in-browser stand-in, not the OpenRocket port.">
            ⚠ Mock API — approximate numbers
          </span>
        )}
        {error && <span className="orw-banner" style={{ color: '#c80000' }}>Analysis failed: {error}</span>}
        <span style={{ flex: 1 }} />
        <Check label="Show warnings" checked={showWarnings} onChange={setShowWarnings} title="Show/hide geometry warnings in the rocket design view." />
      </div>
    </div>
  )
}

function Labeled({ label, children, width, last }: { label: string; children: React.ReactNode; width: number; last?: boolean }) {
  return (
    <div style={{ width, flex: 'none', display: 'flex', flexDirection: 'column', gap: 6, marginRight: last ? 0 : 0 }}>
      <span>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', height: 23 }}>{children}</span>
    </div>
  )
}

function IconBtn({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className="orw-btn" title={title} onClick={onClick} style={{ width: 21, height: 21, padding: 0 }}>
      <img src={pix(icon)} alt={title} />
    </button>
  )
}

export { PX_PER_M_AT_100 }

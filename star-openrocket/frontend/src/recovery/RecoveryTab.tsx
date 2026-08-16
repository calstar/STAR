/**
 * The Recovery tab of STAR OpenRocket: the merged recovery calculator rendered
 * as seven subtabs. Controlled component -- App owns the `recovery` slice of the
 * unified design and passes it in via `ui`/`onChange`; this file keeps only the
 * active-subtab UI state. All panels stay mounted (inactive ones `hidden`) so a
 * half-filled device card survives a subtab switch, matching the standalone app.
 */

import { useEffect, useState } from 'react'
import type { DesignSource, UiConfig } from './types/schema'
import { RecoveryPanel } from './components/recovery/RecoveryPanel'
import { CornersPanel } from './components/corners/CornersPanel'
import { StudyPanel } from './components/study/StudyPanel'
import { CrosscheckPanel } from './components/crosscheck/CrosscheckPanel'
import { AtmospherePanel } from './components/atmosphere/AtmospherePanel'
import { DriftPanel } from './components/drift/DriftPanel'
import { UnitsPanel } from './components/settings/UnitsPanel'

type Tab = 'recovery' | 'corners' | 'study' | 'drift' | 'crosscheck' | 'atmosphere' | 'units'

const TABS: { id: Tab; label: string; hint: string; accent: string }[] = [
  { id: 'recovery', label: 'Setup & Basic Run', hint: 'Descent, loads and off-nominal cases',
    accent: 'border-blue-500 text-blue-400' },
  { id: 'corners', label: 'Corners', hint: 'Uncertainty sweep and the governing corner',
    accent: 'border-violet-500 text-violet-400' },
  { id: 'study', label: 'Sweep', hint: 'Compare designs - parachutes, altitudes, mass',
    accent: 'border-amber-500 text-amber-400' },
  { id: 'drift', label: 'Drift', hint: 'Downwind drift and landing point under recovery',
    accent: 'border-sky-500 text-sky-400' },
  { id: 'crosscheck', label: 'Cross-check',
    hint: 'This tool vs OpenRocket vs the recovery mastersheet',
    accent: 'border-rose-500 text-rose-400' },
  { id: 'atmosphere', label: 'Atmospheric Data', hint: 'Measured climatology at FAR',
    accent: 'border-emerald-500 text-emerald-400' },
  { id: 'units', label: 'Units', hint: 'Which unit each quantity displays in',
    accent: 'border-[var(--color-text-muted)] text-[var(--color-text-primary)]' },
]

interface Props {
  ui: UiConfig
  onChange: (u: UiConfig) => void
  /** Apogee / mass offered by the ascent design (CAD + Flight Dynamics). */
  design: DesignSource
}

export function RecoveryTab({ ui, onChange, design }: Props) {
  const [tab, setTab] = useState<Tab>('recovery')

  // When a from-design toggle is on, keep the vehicle field synced to the ascent
  // design so every panel and the physics use it. Converges: only writes on a
  // real difference. Turning a toggle off leaves the last value in place, editable.
  const { apogeeFromDesign, massFromDesign, lateralFromDesign } = ui.sources
  useEffect(() => {
    let v = ui.vehicle
    if (massFromDesign && design.massKg != null && v.m !== design.massKg) v = { ...v, m: design.massKg }
    if (apogeeFromDesign && design.apogee != null && v.h_a !== design.apogee) v = { ...v, h_a: design.apogee }
    if (lateralFromDesign && design.lateralVelocity != null && v.v_lat !== design.lateralVelocity) v = { ...v, v_lat: design.lateralVelocity }
    if (lateralFromDesign && design.lateralBearing != null && v.v_lat_dir !== design.lateralBearing) v = { ...v, v_lat_dir: design.lateralBearing }
    if (v !== ui.vehicle) onChange({ ...ui, vehicle: v })
  }, [apogeeFromDesign, massFromDesign, lateralFromDesign,
      design.apogee, design.massKg, design.lateralVelocity, design.lateralBearing, ui, onChange])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-8">
        <nav className="-mb-px flex gap-1 border-b border-[var(--color-border)]">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.hint}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                tab === t.id
                  ? t.accent
                  : 'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="py-6">
          <div className={tab === 'recovery' ? '' : 'hidden'}>
            <RecoveryPanel ui={ui} onChange={onChange} design={design} />
          </div>
          <div className={tab === 'corners' ? '' : 'hidden'}>
            <CornersPanel ui={ui} onChange={onChange} />
          </div>
          <div className={tab === 'study' ? '' : 'hidden'}>
            <StudyPanel ui={ui} onChange={onChange} />
          </div>
          <div className={tab === 'drift' ? '' : 'hidden'}>
            <DriftPanel ui={ui} onChange={onChange} />
          </div>
          <div className={tab === 'crosscheck' ? '' : 'hidden'}>
            <CrosscheckPanel ui={ui} />
          </div>
          <div className={tab === 'atmosphere' ? '' : 'hidden'}>
            <AtmospherePanel />
          </div>
          <div className={tab === 'units' ? '' : 'hidden'}>
            <UnitsPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

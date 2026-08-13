/**
 * The Drift tab: how far the vehicle drifts under recovery, and where it lands.
 *
 * The wind can come from three places, in rising order of how much the user is
 * asserting: the monthly climatology **mean** (the realistic central estimate,
 * the same dataset the Atmospheric Data tab plots), its **p95** sibling (a
 * deterministic worst-case wind, standing in for a Monte-Carlo dispersion the
 * tool does not yet do), or a **manual** constant the user types.
 *
 * The physics is the equilibrium "canopy moves with the wind" model in
 * physics/drift.py -- there is no separate "how much wind it catches" term, a
 * round canopy simply goes where the air goes -- so the interesting output is
 * purely geometric: a plan-view ground track plus the distance and bearing.
 *
 * Wind selection is local component state, not on the shared config: it does
 * not change the vehicle, and the panel stays mounted when tabs switch, so a
 * chosen month survives everything but a full reload.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DriftResult, UiConfig, WindInput } from '../../types/schema'
import { runDrift } from '../../api/client'
import { physicsKey, toWireConfig } from '../../lib/serialise'
import { profileWindInput, useWindClimatology, type WindMode } from '../../lib/wind'
import { monthName } from '../../lib/units'
import { useUnits } from '../../lib/unitsContext'
import { Card, Empty, Field, NumberInput, PageHeader, Select, Stat, UnitInput } from '../ui'
import { GroundTrack } from './GroundTrack'
import { WindProfileChart } from './WindProfileChart'

/** 16-point compass label for a bearing, so 293° also reads as WNW. */
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
function compass(deg: number): string {
  return POINTS[Math.round(deg / 22.5) % 16]
}

export function DriftPanel({ ui }: { ui: UiConfig }) {
  const { grid_m, byTag, tags } = useWindClimatology()

  const [mode, setMode] = useState<WindMode>('climatology')
  const [tag, setTag] = useState('edw-nid')
  // Default the month to whatever the Site form is using, so the two tabs agree.
  const [month, setMonth] = useState(ui.site.month)
  const [manualSpeed, setManualSpeed] = useState<number | null>(5) // m/s SI
  const [manualDir, setManualDir] = useState<number | null>(270)   // from west
  const [which, setWhich] = useState<'axial' | 'broadside'>('axial')

  const [drift, setDrift] = useState<DriftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Fall back to the first tag that actually carries wind if the default is
  // absent (e.g. a bundle without the pooled set).
  const activeTag = byTag && byTag[tag] ? tag : tags[0]?.id ?? tag
  const wm = byTag?.[activeTag]?.[month] ?? null
  const isClimatology = mode === 'climatology' || mode === 'worst'

  // The WindInput posted to the backend -- values, not the recipe.
  const windInput = useMemo<WindInput | null>(() => {
    if (!isClimatology) {
      return { kind: 'constant', speed: manualSpeed ?? 0, direction: manualDir ?? 0 }
    }
    if (!wm || !grid_m) return null
    return profileWindInput(wm, grid_m, mode === 'worst')
  }, [isClimatology, manualSpeed, manualDir, wm, grid_m, mode])

  const cfgKey = physicsKey(ui)
  const windKey = JSON.stringify(windInput)
  const seq = useRef(0)

  useEffect(() => {
    if (!windInput) return
    const mine = ++seq.current
    const id = setTimeout(() => {
      setRunning(true)
      runDrift(toWireConfig(ui), windInput, which).then((res) => {
        if (mine !== seq.current) return
        setRunning(false)
        if (res.data) { setDrift(res.data); setError(null) }
        else { setError(res.error ?? 'drift failed'); setDrift(null) }
      })
    }, 250)
    return () => clearTimeout(id)
    // cfgKey/windKey stand in for ui/windInput; `which` re-runs the descent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, windKey, which])

  return (
    <div className="space-y-4">
      <PageHeader title="Drift">
        How far the nominal descent drifts downwind, and where it lands. The
        canopy is carried by the wind at every altitude; pick the wind below.
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <WindControls
          mode={mode} setMode={setMode}
          tag={activeTag} setTag={setTag} tags={tags} hasWind={!!byTag}
          month={month} setMonth={setMonth} byTag={byTag} activeTag={activeTag}
          manualSpeed={manualSpeed} setManualSpeed={setManualSpeed}
          manualDir={manualDir} setManualDir={setManualDir}
          which={which} setWhich={setWhich}
        />

        <div className="space-y-4">
          <DriftResults drift={windInput ? drift : null} error={error} running={running} />
          {isClimatology && wm && grid_m && (
            <Card title={`Wind aloft - ${monthName(month)}`}
                  subtitle="The climatology the drift above is integrated over.">
              <WindProfileChart wm={wm} grid={grid_m} padH={grid_m[0]}
                                worst={mode === 'worst'} />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function WindControls({
  mode, setMode, tag, setTag, tags, hasWind, month, setMonth, byTag, activeTag,
  manualSpeed, setManualSpeed, manualDir, setManualDir, which, setWhich,
}: {
  mode: WindMode; setMode: (v: WindMode) => void
  tag: string; setTag: (v: string) => void; tags: { id: string; label: string }[]
  hasWind: boolean
  month: number; setMonth: (v: number) => void
  byTag: Record<string, Record<number, unknown>> | null; activeTag: string
  manualSpeed: number | null; setManualSpeed: (v: number | null) => void
  manualDir: number | null; setManualDir: (v: number | null) => void
  which: 'axial' | 'broadside'; setWhich: (v: 'axial' | 'broadside') => void
}) {
  const isClimatology = mode === 'climatology' || mode === 'worst'
  return (
    <Card title="Wind">
      <div className="space-y-3">
        <Field label="Source">
          <Select
            value={mode} onChange={setMode}
            options={[
              { value: 'climatology', label: 'Climatology - monthly mean' },
              { value: 'worst', label: 'Worst-case - monthly p95' },
              { value: 'manual', label: 'Manual - constant wind' },
            ]}
          />
        </Field>

        {isClimatology ? (
          !hasWind ? (
            <Empty>No wind climatology in this bundle. Run
              site-climatology/wind_profile.py.</Empty>
          ) : (
            <>
              <Field label="Dataset">
                <Select value={tag} onChange={setTag}
                        options={tags.map((t) => ({ value: t.id, label: t.label }))} />
              </Field>
              <Field label="Month">
                <Select
                  value={String(month)} onChange={(v) => setMonth(Number(v))}
                  options={Array.from({ length: 12 }, (_, i) => {
                    const rec = byTag?.[activeTag]?.[i + 1] as { n: number } | undefined
                    return {
                      value: String(i + 1),
                      label: `${monthName(i + 1)}${rec ? ` (n=${rec.n})` : ' (no data)'}`,
                    }
                  })}
                />
              </Field>
            </>
          )
        ) : (
          <>
            <Field label="Wind speed" kind="speed">
              <UnitInput value={manualSpeed} onChange={setManualSpeed}
                         kind="speed" min={0} />
            </Field>
            <Field label="Direction (from)" unit="°"
                   hint="Bearing the wind blows FROM: 270 is a westerly.">
              <NumberInput value={manualDir} onChange={setManualDir}
                           min={0} max={360} step={5} />
            </Field>
          </>
        )}

        <Field label="Airframe attitude"
               hint="Sets the descent rate, and so the exposure time: broadside falls slower and drifts a touch further.">
          <Select value={which} onChange={setWhich}
                  options={[{ value: 'axial', label: 'Axial (nose-down)' },
                            { value: 'broadside', label: 'Broadside' }]} />
        </Field>
      </div>
    </Card>
  )
}

function DriftResults({ drift, error, running }: {
  drift: DriftResult | null; error: string | null; running: boolean
}) {
  const { num, dec } = useUnits()

  if (error) {
    return (
      <Card title="Drift">
        <Empty>{error}. Drift needs the backend running.</Empty>
      </Card>
    )
  }
  if (!drift) {
    return (
      <Card title="Drift">
        <Empty>{running ? 'Computing…' : 'Pick a wind to compute drift.'}</Empty>
      </Card>
    )
  }

  return (
    <Card title="Drift" subtitle={`Nominal descent, ${drift.airframe_bound} airframe bound.`}>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Drift distance" value={num(drift.distance, 'distance')} kind="distance" />
        <Stat label="Bearing" value={`${dec(drift.bearing_deg, 0)}° ${compass(drift.bearing_deg)}`} />
        <Stat label="Descent time" value={dec(drift.descent_time, 1)} unit="s" />
        <Stat label="Wind at ground" value={num(drift.wind_ground.speed, 'speed')} kind="speed" />
      </div>
      <GroundTrack drift={drift} />
    </Card>
  )
}

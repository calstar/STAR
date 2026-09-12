/**
 * The Drift tab: how far the vehicle drifts under recovery, and where it lands.
 *
 * This is a RESULTS view. The wind is the shared launch wind, chosen once on the
 * top-level Environment tab and carried on `ui.wind`; the loads, the cross-check and
 * the ascent all read the same wind. This tab just runs the nominal descent under it
 * and draws the ground track. The only knob here is the airframe attitude, which sets
 * the descent rate (and so the exposure time), because that is genuinely a drift-only
 * choice — it does not belong to the environment.
 *
 * The physics is the coupled descent in physics/drift.py: a round canopy relaxes toward
 * the local wind, so the interesting output is purely geometric — a plan-view ground
 * track plus the distance and bearing.
 */

import { useEffect, useRef, useState } from 'react'
import type { DriftResult, UiConfig } from '../../types/schema'
import { runDrift } from '../../api/client'
import { physicsKey, toWireConfig } from '../../lib/serialise'
import { useUnits } from '../../../lib/units/unitsContext'
import { Card, Empty, Field, PageHeader, Select, Stat } from '../ui'
import { GroundTrack } from './GroundTrack'

/** 16-point compass label for a bearing, so 293° also reads as WNW. */
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
function compass(deg: number): string {
  return POINTS[Math.round(deg / 22.5) % 16]
}

export function DriftPanel({ ui, onChange }: {
  ui: UiConfig
  onChange: (u: UiConfig) => void
}) {
  // The airframe bound is stored on the shared config, not in local state, so Full
  // Flight (and the save file) reflect this choice without depending on a visit here.
  const which = ui.airframeBound
  const setWhich = (v: 'axial' | 'broadside') => onChange({ ...ui, airframeBound: v })

  const [drift, setDrift] = useState<DriftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const hasWind = ui.wind != null
  // physicsKey folds in the shared wind, so the drift re-runs when the Environment tab
  // changes it; `which` re-runs the descent at the other airframe bound.
  const cfgKey = physicsKey(ui)
  const seq = useRef(0)

  useEffect(() => {
    if (!hasWind) { setDrift(null); return }
    const mine = ++seq.current
    const id = setTimeout(() => {
      setRunning(true)
      runDrift(toWireConfig(ui), which).then((res) => {
        if (mine !== seq.current) return
        setRunning(false)
        if (res.data) { setDrift(res.data); setError(null) }
        else { setError(res.error ?? 'drift failed'); setDrift(null) }
      })
    }, 250)
    return () => clearTimeout(id)
    // cfgKey stands in for ui; `which` re-runs the descent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey, which, hasWind])

  return (
    <div className="space-y-4">
      <PageHeader title="Drift">
        How far the nominal descent drifts downwind, and where it lands. The wind is the
        shared launch wind — pick it on the Environment tab.
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card title="Descent">
          <Field label="Airframe attitude"
                 hint="Sets the descent rate, and so the exposure time: broadside falls slower and drifts a touch further.">
            <Select value={which} onChange={setWhich}
                    options={[{ value: 'axial', label: 'Axial (nose-down)' },
                              { value: 'broadside', label: 'Broadside' }]} />
          </Field>
        </Card>

        <DriftResults drift={hasWind ? drift : null} error={error}
                      running={running} hasWind={hasWind} />
      </div>
    </div>
  )
}

function DriftResults({ drift, error, running, hasWind }: {
  drift: DriftResult | null; error: string | null; running: boolean; hasWind: boolean
}) {
  const { num, dec } = useUnits()

  if (!hasWind) {
    return (
      <Card title="Drift">
        <Empty>Set the wind on the Environment tab to compute drift.</Empty>
      </Card>
    )
  }
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
        <Empty>{running ? 'Computing…' : 'Computing drift…'}</Empty>
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

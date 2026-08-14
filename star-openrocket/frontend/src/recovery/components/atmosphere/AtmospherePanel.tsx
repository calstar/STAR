/**
 * The Atmospheric Data tab.
 *
 * This pane is deliberately read-only. It is not an input form for the
 * recovery run -- the pad state on the Recovery tab is a separate, per-run
 * decision (§5). This is the reference climatology behind that decision:
 * what the pressure and the temperature column at FAR actually do over a year,
 * measured, so a chosen T_pad or p_pad can be sanity-checked against ten years
 * of soundings rather than against intuition.
 */

import { useEffect, useState } from 'react'
import type { Climatology } from '../../types/climatology'
import { getClimatology } from '../../api/client'
import { Badge, Empty, Info, PageHeader } from '../ui'
import { PressureByMonth } from './PressureByMonth'
import { TemperatureByMonth } from './TemperatureByMonth'
import { SoundingProfile } from './SoundingProfile'
import { useUnits } from '../../lib/unitsContext'

export function AtmospherePanel() {
  const { q } = useUnits()
  const [clim, setClim] = useState<Climatology | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getClimatology().then((res) => {
      if (!live) return
      if (res.data) {
        setClim(res.data)
      } else {
        setError(res.error ?? 'could not load climatology')
      }
    })
    return () => { live = false }
  }, [])

  if (error) {
    return <Empty>{error}</Empty>
  }
  if (!clim) {
    return <Empty>Loading climatology…</Empty>
  }

  const pad = clim.meta.pad

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="inline-flex items-center">
            Atmospheric Data
            {/* Coordinates keep their five decimals whatever the precision
                setting says. They are an identifier for a place, not a
                measurement of a quantity -- two decimals moves the pad by
                about a kilometre. */}
            <Info>
              {'Friends of Amateur Rocketry (FAR) data. '
               + `${pad.lat.toFixed(5)}°, ${pad.lon.toFixed(5)}° at ${q(pad.elev_m, 'altitude')} MSL. `
               + 'Surface pressure from the IEM ASOS archive of NWS/FAA METARs, '
               + 'corrected to pad station pressure. Temperature aloft '
               + "from NOAA's Integrated Global Radiosonde Archive, 10 years. "
               + 'Heights are geopotential (H). '
               + `Generated ${clim.meta.generated.slice(0, 10)}.`}
            </Info>
          </span>
        }
      >
        Measured climatology at FAR.
      </PageHeader>

      {pad.elev_is_estimate && (
        <div className="px-1">
          <Badge tone="warning" title={`Pad elevation is unconfirmed. ${q(10, 'altitude')} of error is 0.12% in pressure - worth a GPS fix.`}>
            pad elev estimated
          </Badge>
        </div>
      )}

      <PressureByMonth clim={clim} />
      <TemperatureByMonth clim={clim} />
      <SoundingProfile clim={clim} />
    </div>
  )
}

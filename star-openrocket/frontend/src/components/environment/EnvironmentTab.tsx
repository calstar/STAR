/**
 * Environment: the launch environment shared by BOTH halves of a flight.
 *
 * The ascent (Flight Dynamics / RocketPy) and the descent (Recovery) used to carry
 * their own, independently-edited air: the ascent a constant "placeholder" wind + ISA,
 * the descent a climatology profile + a measured pad atmosphere. Gluing them in the Full
 * Flight tab then stitched two different atmospheres together, and the descent's wind was
 * only ever set as a side effect of visiting the Drift subtab — so the Full Flight ground
 * track silently changed depending on which tabs you had opened.
 *
 * This tab is the single source of truth. It edits `ui.site` (the pad atmosphere:
 * temperature / pressure / lapse) and `ui.wind` (the wind aloft), which both the loads,
 * the descent, the cross-check AND the ascent now read. The month is shared: the pad
 * normals and the wind climatology are always the same month, by construction.
 *
 * Nothing here is new plotting — the atmospheric climatology plots are the existing
 * `AtmospherePanel` moved here verbatim, and the wind-aloft chart is `WindProfileChart`.
 */

import { useEffect, useMemo, useState } from 'react'
import type { UiConfig, WindInput } from '../../recovery/types/schema'
import { usePadClimatology } from '../../recovery/lib/climatology'
import { profileWindInput, useWindClimatology, type WindMode } from '../../recovery/lib/wind'
import { monthName } from '../../recovery/lib/units'
import { toWireConfig } from '../../recovery/lib/serialise'
import {
  Card, Empty, Field, NumberInput, PageHeader, Select, UnitInput,
} from '../../recovery/components/ui'
import { SiteForm } from '../../recovery/components/recovery/InputForms'
import { WindProfileChart } from '../../recovery/components/drift/WindProfileChart'
import { AtmospherePanel } from '../../recovery/components/atmosphere/AtmospherePanel'
import { SelectedAtmosphere } from './SelectedAtmosphere'

export function EnvironmentTab({ recovery: ui, onChange }: {
  recovery: UiConfig
  onChange: (u: UiConfig) => void
}) {
  const { lapseByMonth, padNormals } = usePadClimatology()
  const { grid_m, byTag, tags } = useWindClimatology()

  // Wind-source selection (moved here from the Drift tab, which is now a results view):
  // this is the one place the shared wind is chosen. The month is NOT local — it comes
  // from the Site card below (`ui.site.month`), so the pad atmosphere and the wind aloft
  // are always the same month.
  const [mode, setMode] = useState<WindMode>('climatology')
  const [tag, setTag] = useState('edw-nid')
  const [manualSpeed, setManualSpeed] = useState<number | null>(5) // m/s SI
  const [manualDir, setManualDir] = useState<number | null>(270)   // from west

  const month = ui.site.month
  const activeTag = byTag && byTag[tag] ? tag : tags[0]?.id ?? tag
  const wm = byTag?.[activeTag]?.[month] ?? null
  const isClimatology = mode === 'climatology' || mode === 'worst'

  // The month is a single value on `ui.site`, so the pad atmosphere and the wind aloft
  // are always the same month. The Site card only surfaces a month picker when the month
  // actually drives the atmosphere (a measured temperature profile, or a climatology
  // pressure source); with ISA it is hidden. So when the Site card is NOT showing one and
  // the wind IS climatology, the Wind card surfaces its own picker for the same value.
  const siteShowsMonth = ui.site.profile === 'measured' || ui.site.source === 'climatology'

  // Change the shared month, mirroring SiteForm's own recompute so a month change can
  // never leave (say) January's pressure next to July's lapse. Harmless under ISA (both
  // stay null / standard); real when the profile or pressure source is month-driven.
  const setMonth = (m: number) => {
    const next = { ...ui.site, month: m }
    const lapseRow = lapseByMonth?.[m]
    const padRow = padNormals?.[next.station]?.[m]
    onChange({
      ...ui,
      site: {
        ...next,
        lapse: next.profile === 'measured' && lapseRow ? lapseRow.L / 1000 : null,
        ...(next.source === 'climatology' && padRow ? { T_pad: padRow.T, p_pad: padRow.p } : {}),
      },
    })
  }

  // The WindInput posted to the backend — resolved values, not the recipe.
  const windInput = useMemo<WindInput | null>(() => {
    if (!isClimatology) {
      return { kind: 'constant', speed: manualSpeed ?? 0, direction: manualDir ?? 0 }
    }
    if (!wm || !grid_m) return null
    return profileWindInput(wm, grid_m, mode === 'worst')
  }, [isClimatology, manualSpeed, manualDir, wm, grid_m, mode])

  // Publish the resolved wind onto the shared config so the loads, the descent, the
  // cross-check AND the ascent all use the same wind. Keyed on the resolved value, only
  // written when it actually changed, and never written as `null` — so this tab only ever
  // *sets* the wind (a transient climatology-still-loading null cannot clear it).
  const windKey = JSON.stringify(windInput)
  useEffect(() => {
    if (windInput && JSON.stringify(ui.wind ?? null) !== windKey) {
      onChange({ ...ui, wind: windInput })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windKey])

  // The atmosphere the physics actually uses: the wire site (ISA/standard nulled the same
  // way the solver sees it), plotted over a ceiling matched to the wind-aloft chart so the
  // three profiles share an altitude range.
  const wireSite = useMemo(() => toWireConfig(ui).site, [ui])
  const maxAltAgl = grid_m ? grid_m[grid_m.length - 1] - grid_m[0] : 12000

  // Two subtabs: what THIS design flies through (Selection), vs the full measured
  // climatology to browse (Atmospheric Data), which is reference only and independent
  // of the selection above.
  const [sub, setSub] = useState<'selection' | 'data'>('selection')

  const selection = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SiteForm value={ui.site} onChange={(v) => onChange({ ...ui, site: v })}
                  lapseByMonth={lapseByMonth} padNormals={padNormals} />

        <Card title="Wind"
              subtitle="Drives the drift and the ascent's crosswind. Climatology is taken at the shared launch month.">
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
                !byTag ? (
                  <Empty>No wind climatology in this bundle. Run
                    site-climatology/wind_profile.py.</Empty>
                ) : (
                  <>
                    <Field label="Dataset">
                      <Select value={activeTag} onChange={setTag}
                              options={tags.map((t) => ({ value: t.id, label: t.label }))} />
                    </Field>
                    {siteShowsMonth ? (
                      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                        Month: {monthName(month)} — from the Site card above.
                      </p>
                    ) : (
                      <Field label="Month"
                             hint="Shared with the pad atmosphere, so the wind and the air are the same month.">
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
                    )}
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
            </div>
          </Card>
      </div>

      <SelectedAtmosphere site={wireSite} maxAltitude={maxAltAgl} />

      {isClimatology && wm && grid_m && (
        <Card title={`Wind aloft - ${monthName(month)}`}
              subtitle="The climatology the drift and the ascent crosswind are integrated over.">
          <WindProfileChart wm={wm} grid={grid_m} padH={grid_m[0]}
                            worst={mode === 'worst'} />
        </Card>
      )}
    </div>
  )

  const SUBTABS = [
    { id: 'selection' as const, label: 'Selection',
      hint: 'The site atmosphere and wind this design flies through',
      accent: 'border-emerald-500 text-emerald-400' },
    { id: 'data' as const, label: 'Atmospheric Data',
      hint: 'The full measured climatology at FAR — reference only, independent of the selection',
      accent: 'border-sky-500 text-sky-400' },
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-8">
        <div className="pt-6">
          <PageHeader title="Environment">
            The launch environment, shared by the ascent (Flight Dynamics) and the descent
            (Recovery): the pad atmosphere and the wind aloft. Set it once here and both
            halves of the flight fly through the same air.
          </PageHeader>
        </div>

        <nav className="-mb-px flex gap-1 border-b border-[var(--color-border)]">
          {SUBTABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSub(t.id)}
              title={t.hint}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                sub === t.id
                  ? t.accent
                  : 'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Both panes stay mounted (inactive one hidden) so the climatology fetch and the
            wind selection survive a subtab switch. */}
        <div className="py-6">
          <div className={sub === 'selection' ? '' : 'hidden'}>{selection}</div>
          <div className={sub === 'data' ? '' : 'hidden'}>
            {/* The measured atmospheric climatology at FAR — pressure/temperature by month
                and the sounding profile — moved here from the Recovery calculator, verbatim.
                Reference only: browsing it does not change the selection above. */}
            <AtmospherePanel />
          </div>
        </div>
      </div>
    </div>
  )
}

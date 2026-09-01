/**
 * Two tabs: the recovery run, and the site climatology behind it.
 *
 * Both panels stay mounted and the inactive one is hidden, the same pattern
 * EngineDesign uses. That is not just a perf choice -- flipping to the
 * atmosphere tab to check what a January pad temperature looks like, and back,
 * must not discard a half-filled device card.
 */

import { useCallback, useEffect, useState } from 'react'
import starWordmark from './assets/star-wordmark.png'
import { getHealth } from './api/client'
import type { UiConfig } from './types/schema'
import { loadUiConfig, saveUiConfig } from './lib/persist'
import { ConfigVersions } from './components/versions/ConfigVersions'
import { ReadOnlyProvider } from '@stardesign-ui'
import { RecoveryPanel } from './components/recovery/RecoveryPanel'
import { CornersPanel } from './components/corners/CornersPanel'
import { StudyPanel } from './components/study/StudyPanel'
import { CrosscheckPanel } from './components/crosscheck/CrosscheckPanel'
import { AtmospherePanel } from './components/atmosphere/AtmospherePanel'
import { UnitsPanel } from './components/settings/UnitsPanel'

type Tab = 'recovery' | 'corners' | 'study' | 'crosscheck' | 'atmosphere' | 'units'

const TABS: { id: Tab; label: string; hint: string; accent: string }[] = [
  { id: 'recovery', label: 'Setup & Basic Run', hint: 'Descent, loads and off-nominal cases',
    accent: 'border-blue-500 text-blue-400' },
  { id: 'corners', label: 'Corners', hint: 'Uncertainty sweep and the governing corner',
    accent: 'border-violet-500 text-violet-400' },
  { id: 'study', label: 'Sweep', hint: 'Compare designs - parachutes, altitudes, mass',
    accent: 'border-amber-500 text-amber-400' },
  { id: 'crosscheck', label: 'Cross-check',
    hint: 'This tool vs OpenRocket vs the recovery mastersheet',
    accent: 'border-rose-500 text-rose-400' },
  { id: 'atmosphere', label: 'Atmospheric Data', hint: 'Measured climatology at FAR',
    accent: 'border-emerald-500 text-emerald-400' },
  // Last, and visually quieter than the three that do work. It is a settings
  // screen, not a fourth thing to analyse.
  { id: 'units', label: 'Units', hint: 'Which unit each quantity displays in',
    accent: 'border-[var(--color-text-muted)] text-[var(--color-text-primary)]' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('recovery')
  const [connected, setConnected] = useState<boolean | null>(null)
  const [sha, setSha] = useState<string | null>(null)

  /**
   * The config, held here because two tabs edit and read it: Recovery owns the
   * vehicle, site and devices; Corners owns the sweep bounds and runs the same
   * vehicle through 32 of them.
   *
   * Lifted rather than put in a context -- the app has no context today and one
   * shared value does not earn one. Everything else each panel needs (results,
   * climatology, the sweep response) stays local to that panel.
   *
   * Restored from `localStorage` on open, which is why every tab's inputs
   * survive a reload: they all live on this one object. `loadUiConfig` is
   * passed as an initialiser rather than called, so it runs once instead of on
   * every render.
   */
  const [ui, setUi] = useState<UiConfig>(loadUiConfig)
  // A config is editable only while it is checked out to you. Everything under
  // <main> reads this through ReadOnlyProvider, so a new input cannot
  // accidentally stay live when someone else holds the config.
  const [editable, setEditable] = useState(false)

  useEffect(() => {
    getHealth().then((res) => {
      setConnected(!res.error)
      setSha(res.data?.git_sha ?? null)
    })
  }, [])

  // Debounced, because `ui` changes on every keystroke in every form and this
  // serialises the whole config. 400 ms is well under the time it takes to
  // reach for the reload key and well over a typing gap.
  useEffect(() => {
    const id = setTimeout(() => saveUiConfig(ui), 400)
    return () => clearTimeout(id)
  }, [ui])

  // Stable so ConfigVersions' openDoc / mount effect don't re-run every render.
  // An inline arrow here recreates onRestore each render, which churned the
  // designs bar into a restore -> setUi -> render loop.
  const handleRestore = useCallback((c: UiConfig) => {
    setUi(c)
    saveUiConfig(c)
  }, [])

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src={starWordmark} alt="STAR" className="h-12 w-auto" />
              <div className="h-8 w-px bg-[var(--color-border)]" />
              <div>
                <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
                  Recovery Calculator
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${
                connected === null ? 'animate-pulse bg-yellow-500'
                  : connected ? 'bg-green-500' : 'bg-amber-500'}`} />
              <span className="text-sm text-[var(--color-text-secondary)]">
                {connected === null ? 'Connecting…'
                  : connected ? `Backend :8100${sha ? ` · ${sha.slice(0, 7)}` : ''}`
                  : 'No backend - fixture mode'}
              </span>
            </div>
          </div>

          {/* Versioned designs, tucked between the title and the tabs so the
              design you are on sits with the rest of the app chrome. */}
          <div className="border-t border-[var(--color-border)]">
            <ConfigVersions
              config={ui}
              onRestore={handleRestore}
              onEditableChange={setEditable}
              inline
            />
          </div>

          <nav className="-mb-px flex gap-1">
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
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8">
        {/* Inputs go grey without the checkout. Running a simulation stays
            live -- it reads the config, it does not change it. */}
        <ReadOnlyProvider readOnly={!editable}>
        <div className={tab === 'recovery' ? '' : 'hidden'}>
          <RecoveryPanel ui={ui} onChange={setUi} />
        </div>
        <div className={tab === 'corners' ? '' : 'hidden'}>
          <CornersPanel ui={ui} onChange={setUi} />
        </div>
        <div className={tab === 'study' ? '' : 'hidden'}>
          <StudyPanel ui={ui} onChange={setUi} />
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
      </ReadOnlyProvider>
      </main>
    </div>
  )
}

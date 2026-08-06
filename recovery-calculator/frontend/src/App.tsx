/**
 * Two tabs: the recovery run, and the site climatology behind it.
 *
 * Both panels stay mounted and the inactive one is hidden, the same pattern
 * EngineDesign uses. That is not just a perf choice -- flipping to the
 * atmosphere tab to check what a January pad temperature looks like, and back,
 * must not discard a half-filled device card.
 */

import { useEffect, useState } from 'react'
import { getHealth } from './api/client'
import type { UiConfig } from './types/schema'
import { loadUiConfig, saveUiConfig } from './lib/persist'
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

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-emerald-500">
                {/* A canopy over a payload. */}
                <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth={1.8}>
                  <path d="M2 10a10 10 0 0 1 20 0" strokeLinecap="round" />
                  <path d="M2 10c2.5 0 3.2 -6 5 -6s2.5 6 5 6 3.2 -6 5 -6 2.5 6 5 6" />
                  <path d="M7 10l5 7M17 10l-5 7" strokeLinecap="round" />
                  <rect x="10.5" y="17" width="3" height="4" rx="0.5" />
                </svg>
              </div>
              <div>
                <h1 className="text-lg font-bold text-[var(--color-text-primary)]">
                  Recovery Calculator
                </h1>
                <p className="font-prose text-xs text-[var(--color-text-secondary)]">
                  Parachute descent, opening loads and recovery hardware sizing
                </p>
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
      </main>
    </div>
  )
}

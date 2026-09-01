/**
 * The right-hand inspector: a tabbed sidebar (Altium-style) hosting the part
 * Properties and the whole-rocket Analysis (CM, CP, static margin, fins, motor).
 *
 * Selecting a part auto-switches to Properties so the click and the numbers that
 * describe it stay together -- unless the panel is *pinned*, which locks the active
 * tab so a stray click while reading the Analysis does not yank it away. The pin is
 * read through a ref so toggling it never itself triggers a switch; only a *new*
 * selection does. Manual tab clicks always win, pinned or not.
 */

import { useEffect, useRef, useState } from 'react'

import type { CMResult } from '../../lib/cm'
import { useUnits } from '../../lib/units/unitsContext'
import type { Part, PartOverride } from '../../types'
import { PropertiesPanel } from './PropertiesPanel'
import { Row } from './Row'
import { StabilityPanel, type StabilityPanelProps } from './StabilityPanel'

interface Props extends StabilityPanelProps {
  /** Properties tab: the current selection and its mass overrides. */
  selected: Part[]
  visibleKeys: Set<string>
  overrides: Map<string, PartOverride>
  onOverrideChange: (key: string, override: PartOverride | null) => void
  /** Analysis tab: the live centre of mass and how many parts feed it. */
  cm: CMResult
  partCount: number
  /** CM projected on the rocket axis (from nose) + its off-axis offset; null until
   *  a stability result gives the axis. */
  cmAnalysis: { fromNose: number; radial: number; offAxis: boolean } | null
  /** The primary selected part; a change to a non-null key switches to Properties. */
  primarySelectedKey: string | null
}

type Tab = 'analysis' | 'properties'

export function InspectorPanel({
  selected,
  visibleKeys,
  overrides,
  onOverrideChange,
  cm,
  partCount,
  cmAnalysis,
  primarySelectedKey,
  ...stability
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('analysis')
  const [pinned, setPinned] = useState(false)

  // Read the pin through a ref so the auto-switch effect can key on the selection
  // alone: pinning must not itself move the tab, and unpinning must not retro-switch.
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned

  useEffect(() => {
    if (primarySelectedKey && !pinnedRef.current) setActiveTab('properties')
  }, [primarySelectedKey])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] pr-2">
        <div className="flex">
          <TabButton active={activeTab === 'properties'} onClick={() => setActiveTab('properties')}>
            Properties
          </TabButton>
          <TabButton active={activeTab === 'analysis'} onClick={() => setActiveTab('analysis')}>
            Analysis
          </TabButton>
        </div>
        <PinButton pinned={pinned} onToggle={() => setPinned((p) => !p)} />
      </div>

      {/* One scroll region for whichever tab is up. text-sm matches the parts
          tree so the two sidebars read at the same scale. */}
      <div className="min-h-0 flex-1 overflow-y-auto text-sm">
        {activeTab === 'properties' ? (
          <PropertiesPanel
            selected={selected}
            visibleKeys={visibleKeys}
            overrides={overrides}
            onOverrideChange={onOverrideChange}
          />
        ) : (
          <>
            <MassSummary cm={cm} partCount={partCount} cmAnalysis={cmAnalysis} />
            <StabilityPanel {...stability} />
          </>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-xs font-medium ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
          : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Pin toggle. Pinned = the pin points down (locked); unpinned = it lies sideways
 * (rotated), the same visual language a physical pushpin uses for "held" vs "loose".
 */
function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pinned}
      title={pinned ? 'Panel locked — selecting a part won’t switch tabs' : 'Lock this panel'}
      aria-label={pinned ? 'Unlock panel' : 'Lock panel'}
      className={`rounded p-1 ${
        pinned ? 'text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-4 w-4 transition-transform ${pinned ? '' : '-rotate-45'}`}
      >
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
    </button>
  )
}

/** The live centre of mass, formerly the top card of the floating overlay. */
function MassSummary({
  cm,
  partCount,
  cmAnalysis,
}: {
  cm: CMResult
  partCount: number
  cmAnalysis: { fromNose: number; radial: number; offAxis: boolean } | null
}) {
  const { q } = useUnits()
  return (
    <section className="border-b border-[var(--color-border)] p-3 text-sm">
      <h2 className="mb-2 text-2xs uppercase tracking-wide text-[var(--color-text-muted)]">
        Center of mass — {cm.partCount - cm.masslessCount} of {partCount} parts
      </h2>
      <Row label="Total mass" value={q(cm.mass, 'mass')} />
      {cmAnalysis ? (
        <Row label="CM from nose" value={q(cmAnalysis.fromNose, 'length')} highlight />
      ) : (
        // No axis yet (compute stability): fall back to the raw world coordinate.
        <Row label="CM z (world)" value={q(cm.centroid[2], 'length')} highlight />
      )}

      {cmAnalysis?.offAxis && (
        <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-amber-300">
          ⚠ Mass is off-axis by {q(cmAnalysis.radial, 'length')} — the rocket is
          laterally unbalanced. CG should sit on the centreline; check for an asymmetric or
          material-less part.
        </p>
      )}

      {cm.masslessCount > 0 && (
        <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-amber-300">
          {cm.masslessCount} visible {cm.masslessCount === 1 ? 'part has' : 'parts have'} no mass
          and {cm.masslessCount === 1 ? 'is' : 'are'} not in this figure.
        </p>
      )}
    </section>
  )
}

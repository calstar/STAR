/**
 * The Corners tab: the §11.9 uncertainty sweep.
 *
 * The Recovery tab answers "what does this vehicle do". This one answers "how
 * much of that is actually known" -- and for the worked vehicle the answer is
 * a design load spanning 766 to 2420 N, a factor of 3.2, with the governing
 * candidate changing partway through the range.
 *
 * Unlike the Recovery tab this does NOT run live. A sweep is 2^n integrations
 * -- 32 runs and ~1.5 s on the canonical set, against ~100 ms for all four
 * §11.5 cases -- so it sits behind a button. A previous result stays on screen
 * when the config changes and is marked stale rather than cleared: a stale
 * sweep still tells you which corner governs, and a blank panel tells you
 * nothing.
 */

import { useCallback, useMemo, useState } from 'react'
import type { CaseId, UiConfig } from '../../types/schema'
import { CASE_IDS, CASE_META } from '../../types/schema'
import type { SweepResult } from '../../api/client'
import { runSweep } from '../../api/client'
import { cornersKey, toWireConfig } from '../../lib/serialise'
import type { Channel } from '../chartTheme'
import { CHANNELS, MAX_SELECTED } from '../chartTheme'
import { Badge, Button, Card, Empty, PageHeader } from '../ui'
import { SweepForm } from '../recovery/InputForms'
import { CornerChart } from './CornerChart'
import { CornerTable } from './CornerTable'
import { WorstCards } from './WorstCards'

export function CornersPanel({ ui, onChange }: {
  ui: UiConfig
  onChange: (v: UiConfig) => void
}) {
  const [result, setResult] = useState<SweepResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kase, setKase] = useState<CaseId>('nominal')
  const [channel, setChannel] = useState<Channel>('z')
  const [showContext, setShowContext] = useState(false)

  /** Selection order IS the colour assignment, so this is an array and not a
   *  Set -- unticking the first corner must not repaint the other five. */
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  /** The config the displayed result was computed from. Compared against the
   *  live one to detect staleness; there is no cheaper honest test, and the
   *  string is built once per edit rather than per render. */
  const [ranFrom, setRanFrom] = useState<string | null>(null)
  // `cornersKey`, not the whole config: the Sweep tab's study axes are stored
  // on the same `UiConfig` and cannot move a corner sweep, so adding one must
  // not badge a finished sweep stale.
  const wire = useMemo(() => cornersKey(ui), [ui])
  const stale = result !== null && ranFrom !== null && ranFrom !== wire

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    const snapshot = cornersKey(ui)
    // Trajectories are the whole cost of the response -- 2 MB against 10 kB --
    // and this is the one caller that draws them.
    const res = await runSweep(toWireConfig(ui), kase, true)
    setRunning(false)
    if (!res.data) {
      // No stub fallback, deliberately. `runSweep` has none: a fabricated table
      // of worst cases is the most misleading thing this app could render.
      setError(res.error ?? 'sweep failed')
      return
    }
    setResult(res.data)
    setRanFrom(snapshot)

    // Default to the corners that produced the worst cases -- the union, not
    // a fixed count: structure and impact often share one corner, and showing
    // "three" when there are two would mean padding with an arbitrary third.
    const worst = Object.values(res.data.worst_by_category).map((w) => w.id)
    setSelectedIds([...new Set(worst)].slice(0, MAX_SELECTED))
  }, [ui, kase])

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => prev.includes(id)
      ? prev.filter((x) => x !== id)
      : prev.length >= MAX_SELECTED ? prev : [...prev, id])
  }, [])

  const deployAlts = useMemo(
    () => ui.devices
      .filter((d) => d.trigger.kind === 'ALTITUDE' && d.trigger.value > 0)
      .map((d) => ({ name: d.name, z: d.trigger.value })),
    [ui.devices])

  return (
    <div className="space-y-4">
      <PageHeader title="Corners">
        Every uncertain input at both bounds - the spread is how much of the answer is known.
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run()} variant="primary" disabled={running}>
            {running ? 'Sweeping…' : 'Run sweep'}
          </Button>

          {/* Which §11.5 case the corners are swept WITHIN. A drogue-failure
              sweep is a different question from a nominal one, and the
              endpoint has always taken it. */}
          <div className="flex items-center gap-1">
            {CASE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setKase(id)}
                title={CASE_META[id].detail}
                className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
                  kase === id
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]'
                }`}
              >
                {CASE_META[id].label}
              </button>
            ))}
          </div>

          <span className="ml-auto flex items-center gap-2">
            {result && (
              <Badge tone="neutral">
                {result.runs} corners · {CASE_META[result.case as CaseId]?.label ?? result.case}
              </Badge>
            )}
            {stale && (
              <Badge tone="warning" title="The vehicle, site or sweep bounds changed after this ran.">
                inputs changed - re-run
              </Badge>
            )}
          </span>
        </div>
      </Card>

      {error && (
        <Card title="Sweep failed">
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2">
            <p className="font-prose text-xs leading-relaxed text-red-200">{error}</p>
          </div>
        </Card>
      )}

      {!result && !error && (
        <Card title="Corner sweep">
          <Empty>
            {running
              ? 'Sweeping…'
              : 'Press Run sweep. Every enabled parameter is evaluated at both bounds.'}
          </Empty>
        </Card>
      )}

      {result && (
        <>
          <Card
            title="Flight history by corner"
            subtitle="One line per selected corner. The chart is what tells two equally-bad corners apart."
            right={
              <div className="flex flex-wrap gap-1">
                {CHANNELS.map((c) => (
                  <Button
                    key={c.key}
                    onClick={() => setChannel(c.key)}
                    variant={channel === c.key ? 'primary' : 'ghost'}
                  >
                    {c.label}
                  </Button>
                ))}
              </div>
            }
          >
            <CornerChart
              corners={result.corners}
              nominal={result.nominal}
              selectedIds={selectedIds}
              channel={channel}
              showContext={showContext}
              deployAlts={deployAlts}
            />
          </Card>

          <WorstCards result={result} selectedIds={selectedIds} onSelect={toggle} />
          <CornerTable
            result={result}
            selectedIds={selectedIds}
            onToggle={toggle}
            showContext={showContext}
            onShowContext={setShowContext}
          />
        </>
      )}

      {/* The bounds live with their output, not on the Recovery tab. Editing
          them changes nothing a simulate run would show. */}
      <SweepForm
        value={ui.sweep}
        vehicle={ui.vehicle}
        onChange={(v) => onChange({ ...ui, sweep: v })}
      />
    </div>
  )
}

/**
 * The Sweep tab: comparing designs.
 *
 * The Recovery tab answers "what does this vehicle do" and the Corners tab
 * answers "how much of that is actually known". This one answers the question
 * a designer asks first and the app could not previously answer at all: **what
 * if I picked a different parachute?**
 *
 * Everything runs at nominal conditions -- nominal case, axial airframe, the
 * /api/simulate defaults. The off-nominal cases are deliberately absent: they
 * would multiply the run count by four to answer a question the Recovery tab
 * already answers for each design one at a time, and a study is a comparison
 * between designs rather than an analysis of any one of them.
 *
 * Like Corners, this does not run live -- a study is up to 20 integrations
 * with 20 flight histories attached -- so it sits behind a button and a
 * finished result stays on screen when the config changes, badged stale. A
 * stale study still tells you which canopy was better; a blank panel does not.
 */

import { useCallback, useMemo, useState } from 'react'
import type { UiConfig } from '../../types/schema'
import type { StudyResult } from '../../api/client'
import { runStudy } from '../../api/client'
import { studyKey, toWireConfig } from '../../lib/serialise'
import { MAX_RUNS, runCount } from '../../lib/study'
import type { Channel } from '../chartTheme'
import { CHANNELS } from '../chartTheme'
import { Badge, Button, Card, Empty, PageHeader } from '../ui'
import { AxisEditor } from './AxisEditor'
import { StudyChart } from './StudyChart'
import { StudyTable } from './StudyTable'

export function StudyPanel({ ui, onChange }: {
  ui: UiConfig
  onChange: (v: UiConfig) => void
}) {
  const [result, setResult] = useState<StudyResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<Channel>('z')
  const [showContext, setShowContext] = useState(false)
  /** The current setup, as the dashed reference line and the "now" row. On by
   *  default -- it is what every design is being compared against -- but a
   *  study that has already moved past it is one line and one row clearer
   *  without it. */
  const [showNominal, setShowNominal] = useState(true)

  /** Unticked designs, not ticked ones. The default is the whole family --
   *  seeing all of them at once is the reason the chart exists -- so the list
   *  that needs storing is the exceptions. It also means a fresh result shows
   *  everything without having to seed a selection. */
  const [hidden, setHidden] = useState<string[]>([])

  /** The config the displayed result came from. `studyKey`, not the whole
   *  config: the corner bounds live on the same `UiConfig` and cannot move a
   *  study, so editing them must not badge this stale. */
  const [ranFrom, setRanFrom] = useState<string | null>(null)
  const key = useMemo(() => studyKey(ui), [ui])
  const stale = result !== null && ranFrom !== null && ranFrom !== key

  const runs = runCount(ui.study)
  const enabled = ui.study.filter((a) => a.enabled).length
  const over = runs > MAX_RUNS
  const empty = enabled === 0 || runs < 1

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    const snapshot = studyKey(ui)
    // Trajectories are the whole cost of the response -- 1.7 MB against a few
    // kB -- and this is the one caller that draws them.
    const res = await runStudy(toWireConfig(ui), true)
    setRunning(false)
    if (!res.data) {
      // No stub fallback, deliberately. `runStudy` has none: a fabricated trade
      // study is a table of invented recommendations about what to buy.
      setError(res.error ?? 'study failed')
      return
    }
    setResult(res.data)
    setRanFrom(snapshot)
    setHidden([])
  }, [ui])

  const toggle = useCallback((id: string) => {
    setHidden((prev) => prev.includes(id)
      ? prev.filter((x) => x !== id)
      : [...prev, id])
  }, [])

  /** Trigger altitudes for the chart's horizontal markers -- but only for
   *  devices whose trigger is NOT itself being swept. One rule for a value
   *  that takes five different heights across the study would be a lie. */
  const refLines = useMemo(() => {
    const swept = new Set(
      ui.study.filter((a) => a.enabled && a.key === 'trigger')
        .map((a) => a.device))
    return ui.devices
      .filter((d) => d.trigger.kind === 'ALTITUDE' && d.trigger.value > 0
        && !swept.has(d.name))
      .map((d) => ({ name: d.name, y: d.trigger.value }))
  }, [ui.devices, ui.study])

  return (
    <div className="space-y-4">
      <PageHeader title="Sweep">
        Compare designs - one run per design at nominal conditions.
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void run()}
            variant="primary"
            disabled={running || over || empty}
            title={over ? `Over the ${MAX_RUNS}-design limit`
              : empty ? 'Add a sweep first' : undefined}
           action>
            {running ? 'Running…' : 'Run sweep'}
          </Button>

          <span className="text-xs text-[var(--color-text-secondary)]">
            {empty ? 'no sweeps yet'
              : `${runs} design${runs === 1 ? '' : 's'} at nominal conditions`}
          </span>

          <span className="ml-auto flex items-center gap-2">
            {result && (
              <Badge tone="neutral">{result.runs} run</Badge>
            )}
            {stale && (
              <Badge tone="warning" title="The vehicle, site or the sweeps changed after this ran.">
                inputs changed - re-run
              </Badge>
            )}
          </span>
        </div>
      </Card>

      {error && (
        <Card title="Sweep failed">
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2">
            <p className="text-xs leading-relaxed text-red-200">{error}</p>
          </div>
        </Card>
      )}

      {!result && !error && (
        <Card title="Design sweep">
          <Empty>
            {running
              ? 'Running…'
              : 'Add a sweep below, then press Run. Every combination is run at '
                + 'nominal conditions and drawn on one set of axes.'}
          </Empty>
        </Card>
      )}

      {result && (
        <>
          <Card
            title="Flight history by design"
            subtitle="Every design on one set of axes, against the config you have now."
            right={
              <div className="flex flex-wrap gap-1">
                {CHANNELS.map((c) => (
                  <Button
                    key={c.key}
                    onClick={() => setChannel(c.key)}
                    variant={channel === c.key ? 'primary' : 'ghost'}
                   action>
                    {c.label}
                  </Button>
                ))}
              </div>
            }
          >
            <StudyChart
              points={result.points}
              nominal={result.nominal}
              showNominal={showNominal}
              hidden={hidden}
              channel={channel}
              showContext={showContext}
              refLines={refLines}
            />
          </Card>

          <StudyTable
            result={result}
            hidden={hidden}
            onToggle={toggle}
            showContext={showContext}
            onShowContext={setShowContext}
            showNominal={showNominal}
            onShowNominal={setShowNominal}
            devices={ui.devices}
          />
        </>
      )}

      {/* The sweeps live with their output, not on the Recovery tab. Editing
          them changes nothing a simulate run would show. */}
      <AxisEditor ui={ui} onChange={onChange} />
    </div>
  )
}

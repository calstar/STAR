/**
 * The Cross-check tab: is any of this right?
 *
 * The other three tabs all answer questions about the vehicle. This one answers
 * a question about the *tool*. PLAN.md §2 claims three defects in OpenRocket's
 * descent model and the README repeats them; the team's mastersheets have sized
 * real flight hardware and have never been checked against anything. Both
 * claims were prose. This makes them numbers.
 *
 * It runs debounced-automatic like the Recovery tab rather than behind a button
 * like Corners and Sweep, and the reason is cost: this is three integrations,
 * about 80 ms, with no combinatorial term. There is nothing to defer.
 *
 * No stub fallback anywhere in here. A fabricated cross-check is a fabricated
 * validation, which is worse than a blank panel by a wide margin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CrosscheckResult } from '../../api/client'
import { runCrosscheck } from '../../api/client'
import { physicsKey, toWireConfig } from '../../lib/serialise'
import type { UiConfig } from '../../types/schema'
import type { Channel } from '../chartTheme'
import { CHANNELS } from '../chartTheme'
import { Badge, Button, Card, Empty, NumberInput, PageHeader } from '../ui'
import { CrosscheckAssumptions } from './CrosscheckAssumptions'
import { CrosscheckChart } from './CrosscheckChart'
import { CrosscheckTable } from './CrosscheckTable'

export function CrosscheckPanel({ ui }: { ui: UiConfig }) {
  const [result, setResult] = useState<CrosscheckResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<Channel>('z')
  /** Mastersheet drift only. Ours and OpenRocket's runs are windless either
   *  way, so this moves exactly one row and says so. */
  const [wind, setWind] = useState(0)

  const first = useRef(true)

  const run = useCallback(async (cfg: UiConfig, windMs: number) => {
    setRunning(true)
    setError(null)
    const res = await runCrosscheck(toWireConfig(cfg), windMs)
    setRunning(false)
    if (!res.data) {
      setError(res.error ?? 'cross-check failed')
      return
    }
    setResult(res.data)
  }, [])

  /**
   * The re-run keys off `physicsKey(ui)`, not off `ui`, for the same reason
   * `RecoveryPanel` does: `ui` carries the corner bounds and the study axes,
   * and neither can move a cross-check. Depending on `ui` meant ticking a
   * month in a design sweep cost three integrations here.
   *
   * It also fixed a wrong error message. A half-built axis -- one added but
   * with nothing picked yet -- is not a legal `Config`, so posting it is a 422,
   * and this tab was the one posting it. The Recovery tab never had the
   * problem because it has always keyed off `physicsKey`.
   */
  const key = useMemo(() => physicsKey(ui), [ui])

  useEffect(() => {
    const delay = first.current ? 0 : 250
    first.current = false
    const id = setTimeout(() => { void run(ui, wind) }, delay)
    return () => clearTimeout(id)
    // `ui` is deliberately absent: `key` is the part of it that matters, and
    // `run` reads the latest `ui` through the closure when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wind, run])

  /** Trigger altitudes, for the altitude channel. Every model deploys at the
   *  same configured altitude even though they reach it at different times. */
  const refLines = useMemo(
    () => ui.devices
      .filter((d) => d.trigger.kind === 'ALTITUDE' && d.trigger.value > 0)
      .map((d) => ({ name: d.name, y: d.trigger.value })),
    [ui.devices],
  )

  return (
    <div className="space-y-4">
      <PageHeader title="Cross-check">
        This tool vs OpenRocket vs the recovery mastersheet. Comparison only
        - nothing on this tab sizes hardware.
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          {/* No version badge here. The release is already in the model's own
              label -- it names the chart legend and both table headers -- so a
              badge repeated it a fourth time. The commit still travels in the
              response for provenance. */}
          <span className="ml-auto flex items-center gap-2">
            {running && <Badge tone="neutral">running…</Badge>}
          </span>
        </div>
      </Card>

      {error && (
        <Card title="Cross-check failed">
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2">
            <p className="font-prose text-xs leading-relaxed text-red-200">{error}</p>
          </div>
        </Card>
      )}

      {!result && !error && (
        <Card>
          <Empty>{running ? 'Running…' : 'Waiting for a config.'}</Empty>
        </Card>
      )}

      {result && (
        <>
          <Card
            title="Descent by model"
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
            <CrosscheckChart
              models={result.models}
              channel={channel}
              refLines={refLines}
            />
          </Card>

          <CrosscheckTable metrics={result.metrics} models={result.models} />

          <Card
            title="Wind"
            subtitle="Moves the drift row and nothing else. Drift in this model is coming soon."
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-40">
                <NumberInput
                  value={wind}
                  onChange={(v) => setWind(Math.max(0, v ?? 0))}
                  min={0}
                  step={0.5}
                />
              </div>
              <p className="font-prose text-xs leading-relaxed text-[var(--color-text-secondary)]">
                m/s.
              </p>
            </div>
          </Card>

          <CrosscheckAssumptions
            shared={result.assumptions.shared}
            differs={result.assumptions.differs}
            models={result.models}
            warnings={result.warnings}
          />
        </>
      )}
    </div>
  )
}

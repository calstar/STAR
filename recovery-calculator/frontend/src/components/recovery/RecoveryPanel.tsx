/**
 * The Recovery tab: inputs on the left, results on the right.
 *
 * The run is debounced-automatic rather than button-only. PLAN.md §11.2 argues
 * the library and the UI are built together because the failure modes here are
 * mostly *shapes* -- a wrong j, a mis-sequenced event, a tau clock that fails
 * to reset -- and those are far easier to catch on a live plot than in a
 * regenerated PNG. A live plot means the plot updates while you edit.
 *
 * A full descent is ~23 ms and all four cases are under 100 ms, so there is no
 * cost argument for gating it behind a button (§11.5 makes the same point).
 * The button stays for a forced re-run.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Result, UiConfig } from '../../types/schema'
import { simulate } from '../../api/client'
import { usePadClimatology } from '../../lib/climatology'
import { defaultUiConfig, physicsKey, toWireConfig } from '../../lib/serialise'
import { Button, Card, PageHeader } from '../ui'
import { InputColumn } from './InputForms'
import { DeviceList } from './DeviceList'
import { ResultsPanel } from './ResultsPanel'

export function RecoveryPanel({ ui, onChange: setUi }: {
  ui: UiConfig
  onChange: (v: UiConfig) => void
}) {
  const [result, setResult] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)

  /** The measured lapse rates and monthly normals the Site form resolves the
   *  pad state from. Shared with the Sweep tab's pad-state axes, which resolve
   *  from the same reduction -- see `lib/climatology`. */
  const { lapseByMonth, padNormals } = usePadClimatology()

  // Guards against a slow response overwriting a newer one.
  const seq = useRef(0)

  const run = useCallback(async (cfg: UiConfig) => {
    const mine = ++seq.current
    setRunning(true)
    const res = await simulate(toWireConfig(cfg))
    if (mine !== seq.current) return
    setRunning(false)
    if (res.data) {
      setResult(res.data)
      setError(null)
    } else {
      setError(res.error ?? 'simulate failed')
    }
  }, [])

  /**
   * The live re-run keys off `physicsKey(ui)` rather than off `ui`, because
   * `ui` carries a pile of state the physics cannot see: whether a device card
   * is collapsed, which catalog row filled it, the corner-sweep bounds.
   * Depending on `ui` meant collapsing a card cost a full run for a result
   * that could not differ. Unit preferences are not in `ui` at all, so they
   * cannot reach this either -- see `physicsKey`.
   */
  const key = useMemo(() => physicsKey(ui), [ui])

  useEffect(() => {
    if (!live) return
    const id = setTimeout(() => { void run(ui) }, 250)
    return () => clearTimeout(id)
    // `ui` is deliberately absent: `key` is the part of it that matters, and
    // `run` reads the latest `ui` through the closure when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, run])

  const download = (name: string, body: unknown) => {
    const blob = new Blob([JSON.stringify(body, null, 2)],
                          { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Setup & Basic Run">
        Descent, loads and off-nominal cases.
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run(ui)} variant="primary" disabled={running} action>
            {running ? 'Running…' : 'Run'}
          </Button>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={live}
                   onChange={(e) => setLive(e.target.checked)}
                   className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
            re-run while editing
          </label>

          <span className="mx-2 h-4 w-px bg-[var(--color-border)]" />

          {/* Named designs live on the Designs bar (server, with file save/load).
              These two are the one-file snapshot of this run for sharing. */}
          <Button
            onClick={() => download('recovery-setup.json', { config: toWireConfig(ui), result })}
            title="Download your inputs and, if you have run, the results together in one file."
           action>
            Download setup
          </Button>
          <Button
            onClick={() => result && download('result.json', result)}
            disabled={!result}
            title="The full export bundle - figures, report, git SHA - is written server-side. This is just the result object."
           action>
            Export result.json
          </Button>

          <span className="ml-auto flex items-center gap-2">
            <Button onClick={() => setUi(defaultUiConfig())} variant="ghost">
              Reset
            </Button>
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <DeviceList
            devices={ui.devices}
            onChange={(devices) => setUi({ ...ui, devices })}
          />
          <InputColumn ui={ui} onChange={setUi} lapseByMonth={lapseByMonth}
                       padNormals={padNormals} />
        </div>
        <ResultsPanel result={result} running={running} error={error} />
      </div>
    </div>
  )
}

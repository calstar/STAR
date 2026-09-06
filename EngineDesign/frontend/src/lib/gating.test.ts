/**
 * Every control that edits the design must be gated on the checkout.
 *
 * A design is editable only while it is checked out to you. The server refuses
 * the write, but the server refusing is the *last* line -- if a control stays
 * live, the user edits, nothing persists, and the design appears to lose their
 * work. Exactly that shipped: for a long time `ConfigEditor` was the only
 * component in this app that consulted the read-only context at all, so with no
 * checkout essentially the whole UI was still typeable.
 *
 * This is a source audit rather than a rendering test, in the style of
 * recovery-calculator's `lib/gating.test.ts`. It cannot know what a control
 * *means*, so it checks the one thing it can check mechanically: inside the
 * components that edit the design, every raw interactive element either
 * consults `readOnly` in its own `disabled`, or sits inside a
 * `<fieldset disabled={readOnly}>`, which disables its whole subtree natively.
 * Anything deliberately live is listed below with a reason, which keeps the
 * exceptions honest and visible.
 *
 * Note it demands `readOnly` specifically, not merely the presence of a
 * `disabled` prop. Unlike recovery-calculator, this app has no gated input
 * primitives -- its controls are raw JSX carrying their own busy/loading flags,
 * so `disabled={isRunning}` is extremely common and would satisfy a
 * presence-only check while gating nothing at all.
 */

import { describe, expect, it } from 'vitest'

/**
 * Files exempt from the control audit, with a reason each.
 *
 * Deliberately a deny-list, not an allow-list. An allow-list only covers files
 * somebody remembered to add, so a brand new component full of ungated inputs
 * sails straight past it -- which is the one thing this test exists to prevent.
 * Everything under components/ is audited unless it is named here.
 *
 * The "not part of the design yet" entries are temporary. Those panels hold
 * real engineering input that simply has nowhere to persist: it is not in
 * PintleEngineConfig, so gating it today would only stop a read-only viewer
 * running their own analysis. As each one moves into the design payload
 * (lib/designState.ts) its entry here must go, in the same change.
 */
const NOT_EDITING: Record<string, string> = {
  // The designs bar itself. Take, Release, History and the design picker must
  // stay live precisely when you do not hold the design.
  'DesignVersions.tsx': 'the designs bar; its controls are how you get the checkout',
  'ui.tsx': 're-exports the shared Modal',

  // Read-only analysis: these send the config somewhere and show a result.
  'ChamberGeometry.tsx': 'reads geometry from the config',
  'ChamberContourPlot.tsx': 'chart controls (half view, units)',
  'ChamberThermalGraphic.tsx': 'chart controls (half view, units)',
  'HeatFluxProfileChart.tsx': 'chart controls (which time slices to draw)',
  'StabilityPanel.tsx': 'sensitivity sliders feeding one evaluate() call',

  // Not part of the design yet -- see the note above.
}

/**
 * Individual controls that must be gated, in components that are NOT wholly
 * design-editing.
 *
 * TimeSeriesMode and FlightSimulation are mostly analysis: their fields feed a
 * run and are not stored in the design (yet). But each has exactly one control
 * that does write the config, and listing the whole component in EDITING would
 * demand gating dozens of inputs that legitimately stay live. This pins the one
 * that matters, by `File.tsx:marker`.
 */
const MUST_GATE: Record<string, string> = {
  'FlightSimulation.tsx:onClick={handleSaveConfig}': 'Save Configuration -> updateConfig',
  'TimeSeriesMode.tsx:accept=".csv,.yaml,.yml"': 'CSV/YAML upload -> set_config (from-csv)',
}

/**
 * Raw controls that are deliberately live while read-only, because they change
 * what you are looking at rather than the design. Each needs a reason.
 */
const VIEW_ONLY: Record<string, string> = {
  'ConfigEditor.tsx:setSearchQuery': 'filters which sections are shown',
  'ConfigEditor.tsx:setIsExpanded': 'expand/collapse a section',
  'ConfigUpload.tsx:label': 'the drop zone wrapper, not a control',
  'Layer1Optimization.tsx:setShowParameterPlots': 'chart visibility',
  'Layer1Optimization.tsx:setShowInjectorPressures': 'chart visibility',
  'Layer1Optimization.tsx:setShowSolverInputsEcho': 'diagnostics visibility',
  'Layer1Optimization.tsx:setMomentumRAuditOpen': 'diagnostics visibility',
  'Layer2Optimization.tsx:setShowAdvanced': 'shows the advanced settings block',
  'OptimizerDemo.tsx:setShowRequirementsForm': 'collapses the requirements form',
  'Optimizer.tsx:setActiveSubTab': 'which optimizer sub-tab is shown',
  'DemoLayerCard.tsx:setIsExpanded': 'expand/collapse a layer card',
  'FlightSimulation.tsx:setIsExpanded': 'expand/collapse a section',
  'Layer4Optimization.tsx:setIsExpanded': 'expand/collapse a section',
  'Layer4Optimization.tsx:onClick={runSimulation}': 'runs the flight sim; writes nothing',
  'ForwardMode.tsx:handleEvaluate()': 'runs evaluate(); reads the config, never writes it',
  'FlightSimulation.tsx:handleOptimize : handleSimulate': 'runs the flight sim; writes nothing',
  'CustomPlotter.tsx:setShowDataPreview': 'shows the raw data table under the chart',
  'CustomPlotter.tsx:onClick={handleDownloadENG}': 'exports a thrust curve file',
  'CustomPlotter.tsx:onClick={handleDownloadCSV}': 'exports the plotted data',
  'StabilityDiagnostics.tsx:setShowAssumptions': 'shows the assumptions block',
  'StabilityGlossary.tsx:setOpen': 'opens the glossary',
  'PressureCurveChart.tsx:headers': 'downloads the curve as CSV',
  'ControllerMode.tsx:onClick={handleInit}': 'runs the controller sim; reads the config, never writes it',
  'ControllerMode.tsx:onClick={handleSimulate}': 'runs the controller sim; reads the config, never writes it',
  'PressureProfileForm.tsx:onClick={onSubmit}': 'generates the time series; results only',
  'TimeSeriesMode.tsx:onClick={handleSegmentSubmit}': 'generates the time series; results only',
  'TimeSeriesMode.tsx:onClick={handleBlowdownSubmit}': 'generates the time series; results only',
  'TimeSeriesMode.tsx:onClick={handleUploadSubmit}': 'the file input beside it is what carries the checkout gate',

  // Stopping a run you started. Deliberately live: a checkout can lapse while a
  // long optimisation is going, and you must still be able to stop it.
  'Layer1Optimization.tsx:onClick={handleStop}': 'stops a running optimisation',
  'Layer2Optimization.tsx:onClick={handleStop}': 'stops a running optimisation',
  'Layer2Optimization.tsx:onClick={handleStopController}': 'stops a running controller sim',
  'Layer3Optimization.tsx:onClick={handleStop}': 'stops a running optimisation',
  'OptimizerDemo.tsx:onClick={handleStop}': 'stops a running optimisation',

  // Exports. They read results and hand you a file; nothing is written.
  'Layer1Optimization.tsx:config_yaml': 'downloads the result config as a file',
  'Layer2Optimization.tsx:downloadCSV': 'downloads results as a file',
  'Layer2Optimization.tsx:downloadConfig': 'downloads the result config as a file',
  'Layer3Optimization.tsx:downloadCSV': 'downloads results as a file',
  'Layer3Optimization.tsx:downloadConfig': 'downloads the result config as a file',

  // /control/upload-config-and-simulate restores the previous config in a
  // finally block (backend/routers/control.py), so it does not leave the
  // session changed -- it is a simulation, not an edit.
  'Layer2Optimization.tsx:setControllerLoading': 'simulate-from-file; restores the config afterwards',

  // Replays the Layer 2 thrust curve through the controller. /control/
  // simulate-layer2-stream computes and streams; it never calls set_config.
  'Layer2Optimization.tsx:onClick={handleRunController}': 'simulates from results; writes nothing',

  // Local demo state only.
  'OptimizerDemo.tsx:handleReset': 'clears this tab\'s own results',
  'OptimizerDemo.tsx:handleContinueToLayer4': 'runs the flight sim, which does not write the config',
}

const raw = import.meta.glob('../components/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/**
 * Source with comments blanked out, same length so offsets still line up.
 *
 * Needed because these files *discuss* their own controls: a comment reading
 * "the <input disabled> does not cover drops" is not a control, and scanning it
 * as one produces findings nobody can act on. `//` is only treated as a comment
 * when it does not follow a colon, so `https://` inside a string survives.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
}

const files: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([p, src]) => [p, stripComments(src)]),
)

/** The full opening tag, not just up to the first `>` -- an arrow function in an
 *  onClick contains one and would truncate it. */
function openingTags(src: string, tag: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = []
  const re = new RegExp(`<${tag}\\b`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    for (let i = m.index; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) {
        out.push({ text: src.slice(m.index, i), at: m.index })
        break
      }
    }
  }
  return out
}

/**
 * Character ranges covered by a `<fieldset disabled=...>`.
 *
 * A disabled fieldset disables every descendant control natively, which is how
 * the 33-field requirements form is gated: one wrapper rather than 33 props, so
 * a field added later cannot quietly escape the checkout.
 */
function disabledFieldsetSpans(src: string): [number, number][] {
  const spans: [number, number][] = []
  for (const { text, at } of openingTags(src, 'fieldset')) {
    if (!/disabled=\{[^}]*\breadOnly\b/.test(text)) continue
    let depth = 0
    for (let i = at; i < src.length; i++) {
      if (src.startsWith('<fieldset', i)) depth++
      else if (src.startsWith('</fieldset', i)) {
        depth--
        if (depth === 0) {
          spans.push([at, i])
          break
        }
      }
    }
  }
  return spans
}

/**
 * The VIEW_ONLY key covering this control, if any.
 *
 * A key is `File.tsx:marker`, where `marker` is any distinctive substring of
 * the opening tag -- usually the handler name. Matching on a substring rather
 * than a derived id is what keeps the third test below able to prove an excuse
 * still points at real source.
 */
function excuseFor(file: string, tag: string): string | null {
  for (const key of Object.keys(VIEW_ONLY)) {
    const [f, marker] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (f === file && tag.includes(marker)) return key
  }
  return null
}

describe('every design-editing control is gated on the checkout', () => {
  it('keeps every exemption pointing at a real file', () => {
    const stale = Object.keys(NOT_EDITING).filter(
      (name) => !Object.keys(files).some((p) => p.endsWith(`/${name}`)),
    )
    expect(stale, `NOT_EDITING names files that no longer exist: ${stale.join(', ')}`).toEqual([])
  })

  it('leaves no ungated input, select, textarea or button', () => {
    const offenders: string[] = []

    for (const [path, src] of Object.entries(files)) {
      const name = path.split('/').pop()!
      if (name in NOT_EDITING) continue

      const spans = disabledFieldsetSpans(src)
      const inFieldset = (at: number) => spans.some(([s, e]) => at > s && at < e)

      for (const tag of ['input', 'select', 'textarea', 'button']) {
        for (const { text, at } of openingTags(src, tag)) {
          if (/\breadOnly\b/.test(text)) continue
          if (inFieldset(at)) continue
          if (excuseFor(name, text)) continue
          offenders.push(`${name}  ${text.replace(/\s+/g, ' ').slice(0, 100)}`)
        }
      }
    }

    expect(offenders, `ungated controls:\n${offenders.join('\n')}`).toEqual([])
  })

  it('gates the individual write controls in analysis-heavy components', () => {
    const ungated: string[] = []
    for (const [key, why] of Object.entries(MUST_GATE)) {
      const i = key.indexOf(':')
      const [file, marker] = [key.slice(0, i), key.slice(i + 1)]
      const src = Object.entries(files).find(([p]) => p.endsWith(`/${file}`))?.[1]
      if (!src) {
        ungated.push(`${key} — no such component`)
        continue
      }
      const tag = ['input', 'select', 'textarea', 'button']
        .flatMap((t) => openingTags(src, t))
        .find(({ text }) => text.includes(marker))
      if (!tag) ungated.push(`${key} — no control matches (${why})`)
      else if (!/\breadOnly\b/.test(tag.text)) ungated.push(`${key} — not gated (${why})`)
    }
    expect(ungated, ungated.join('\n')).toEqual([])
  })

  it('keeps every VIEW_ONLY excuse pointing at real source', () => {
    const stale = Object.keys(VIEW_ONLY).filter((key) => {
      const i = key.indexOf(':')
      const [file, marker] = [key.slice(0, i), key.slice(i + 1)]
      const src = Object.entries(files).find(([p]) => p.endsWith(`/${file}`))?.[1]
      return !src || !src.includes(marker)
    })
    expect(stale, `stale VIEW_ONLY entries: ${stale.join(', ')}`).toEqual([])
  })
})

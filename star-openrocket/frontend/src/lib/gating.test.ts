/**
 * Every control that edits the design must be gated on the checkout -- the
 * viewer half of the same audit `recovery/lib/gating.test.ts` runs over the
 * recovery tabs.
 *
 * A design is editable only while it is checked out to you. That is enforced on
 * the server, and the bar stops autosaving without it -- so a control that
 * stays live is worse than a no-op: the user edits, nothing persists, and the
 * design appears to lose their work.
 *
 * A source audit rather than a rendering test. It cannot know what a control
 * *means*, so it enforces the one thing it can check mechanically: inside the
 * viewer components, every raw interactive element carries a `disabled`.
 * Anything genuinely view-only is listed below with a reason, which keeps the
 * exceptions honest and visible.
 */

import { describe, expect, it } from 'vitest'

/**
 * Raw controls that are deliberately live while read-only, because they change
 * what you are looking at rather than the design. Each needs a reason.
 *
 * Part visibility and selection are the big ones: neither is saved in
 * `OrkConfig` (see types/config.ts), so hiding a part is a view action.
 */
const VIEW_ONLY: Record<string, string> = {
  'PropertiesPanel.tsx:onOpacityChange': 'part opacity in the 3D view; not saved in OrkConfig',
  'PropertiesPanel.tsx:onShowAssemblyCentroidChange': 'draws the Onshape CM marker; a view toggle',
  'PartList.tsx:onSelect([])': 'clears the selection, which is not saved',
  'PartList.tsx:onContextMenu': 'opens the menu; the menu items carry their own disabled',
  'InspectorPanel.tsx:onClick={onClick}': 'panel tab switch',
  'InspectorPanel.tsx:onToggle': 'pin toggle, local panel state',
  'StabilityPanel.tsx:onToggleIsolate': 'isolates the outer surface in the 3D view',
  'StabilityPanel.tsx:onViewMotorCurves': 'opens the thrust-curve popup',
  'StabilityPanel.tsx:onViewFlight': 'opens the flight-profile popup',
  'StabilityPanel.tsx:setPickerOpen((v) => !v)': 'opens/closes the motor list; picking one is gated',
  'MotorPicker.tsx:setQuery(e.target.value)': 'search box, local state',
  'MotorPicker.tsx:onClose': 'closes the picker',
  'MotorPicker.tsx:setImpulseClass': 'impulse-class filter, local state',
  'ModelPicker.tsx:setQuery(event.target.value)': 'search box, local state',
  'ModelPicker.tsx:refreshDocuments': 'refetches the Onshape document list; touches no design',
  'ModelPicker.tsx:loadAssemblies': 'expands a document in the list',
  'ModelPicker.tsx:chooseDocument': 'expands a document in the list',
  'ModelPicker.tsx:setChosen': 'list navigation, local state',
  'FlightDynamicsTab.tsx:setExpanded': 'expands a chart',
  'FlightDynamicsTab.tsx:run': 'runs the flight simulation; reads the design',
  'FlightDynamicsTab.tsx:toggleCompare': 'which series the chart draws; localStorage, not the design',
  'FullFlightTab.tsx:toggle(d.key)': 'which series the chart draws; localStorage, not the design',
  'EnvironmentTab.tsx:setSub(t.id)': 'subtab switch',
  'MotorCurvesModal.tsx:onClose': 'closes the popup',
  'FlightProfileModal.tsx:onClose': 'closes the popup',
}

/**
 * The viewer components. `App.tsx` is excluded: its own controls are the tab
 * bar and two display toggles (part opacity, the Onshape-CM marker), none of
 * which is saved in the design, and the design bar it renders must stay live so
 * you can take the checkout in the first place.
 */
const files = import.meta.glob('../components/{viewer,environment}/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/** The full opening tag, not just up to the first `>` -- an arrow function in an
 *  onClick contains one and would truncate it. */
function openingTags(src: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    for (let i = m.index; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) {
        out.push(src.slice(m.index, i))
        break
      }
    }
  }
  return out
}

describe('checkout gating (viewer)', () => {
  it('audits a non-empty set of files', () => {
    // A glob that silently matches nothing would make every assertion below
    // pass while checking nothing at all.
    expect(Object.keys(files).length).toBeGreaterThan(5)
  })

  it('leaves no ungated raw control in the viewer', () => {
    const offenders: string[] = []
    for (const [path, src] of Object.entries(files)) {
      const name = path.split('/').pop() as string
      for (const tag of ['button', 'input', 'select', 'textarea']) {
        for (const open of openingTags(src, tag)) {
          // A bare `disabled={busy}` is NOT enough. Recompute carried exactly
          // that and still wrote three design fields, so the audit passed while
          // the control was ungated. The attribute has to actually consult the
          // read-only state -- either inline, or via a `disabled` prop the
          // parent wires to it (ModelPicker), or via `useDisabled()` inside the
          // component, which surfaces as `disabled={disabled}`.
          // Inspect the `disabled` EXPRESSION, not the whole tag. Matching
          // anywhere in the tag is worthless: a `title={readOnly ? ... }`
          // explaining why a control is dead satisfied it while the control
          // itself stayed live. The expression must consult read-only state --
          // inline, or through a `disabled` prop / `useDisabled()`, both of
          // which read as the identifier `disabled` in the expression.
          const expr = /disabled=\{([^}]*)\}/.exec(open)?.[1]
          if (expr && /readOnly|\bdisabled\b/.test(expr)) continue
          const excused = Object.keys(VIEW_ONLY).find((k) => {
            const [file, marker] = k.split(':')
            return name === file && open.includes(marker)
          })
          if (excused) continue
          offenders.push(`${name}: ${open.replace(/\s+/g, ' ').slice(0, 70)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the view-only exception list honest', () => {
    // An exception that no longer matches anything is stale, and a stale list is
    // how a real control quietly acquires an excuse it does not deserve.
    const unused = Object.keys(VIEW_ONLY).filter((k) => {
      const [file, marker] = k.split(':')
      return !Object.entries(files).some(
        ([p, src]) => p.endsWith(`/${file}`) && src.includes(marker),
      )
    })
    expect(unused).toEqual([])
  })
})

/**
 * The design bar's bootstrap must not combine a once-only ref guard with a
 * cleanup-set `cancelled` flag.
 *
 * Either alone is fine. Together they lose the design list on every load in
 * dev: StrictMode runs the effect, fires the cleanup (setting `cancelled`),
 * then runs it again -- and the second run returns early on the ref, so the
 * only in-flight request is the first one, whose `cancelled` is now true. It
 * resolves, bails before setDocuments, and the bar renders empty with
 * "No designs yet" in Change while the designs sit safely on the server.
 *
 * This shipped once, was fixed, and came back when the bar was rebuilt on the
 * shared components. A rendering test would be better but this codebase has no
 * React test harness, and the failure is visible in the source.
 */
describe('design bar bootstrap', () => {
  const bar = Object.entries(
    import.meta.glob('../components/versions/*.tsx', {
      eager: true, query: '?raw', import: 'default',
    }) as Record<string, string>,
  )

  it('finds the bar', () => {
    expect(bar.length).toBe(1)
  })

  it('does not guard the bootstrap with both a ref and a cancelled flag', () => {
    for (const [path, src] of bar) {
      // The effect body, from the ref guard to the end of the file's first
      // `}, [openDoc])`. Comments mentioning `cancelled` are fine; code is not.
      const start = src.indexOf('const bootstrapped = useRef(false)')
      expect(start, `${path} has no once-only bootstrap guard`).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('}, [openDoc])', start))
      const code = body
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      expect(/\bcancelled\b/.test(code), `${path} combines a ref guard with a cancelled flag`)
        .toBe(false)
    }
  })
})

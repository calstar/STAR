/**
 * Every control that edits the diagram must be gated on the checkout.
 *
 * A diagram is editable only while it is checked out to you. The server refuses
 * the write, but the server refusing is the *last* line -- if a control stays
 * live, the user acts, nothing persists, and the work appears to vanish. That
 * shipped here: `ReadOnlyProvider` wrapped only `<PIDCanvas>`, so the canvas was
 * inert without the checkout while the toolbar above it was not. A viewer could
 * press Clear and watch the diagram they were looking at empty out.
 *
 * This is a source audit rather than a rendering test, in the style of
 * recovery-calculator's `lib/gating.test.ts`. It checks the two things it can
 * check mechanically for a canvas app:
 *
 *   1. Raw controls in the editing chrome carry `readOnly` in their `disabled`.
 *   2. The ReactFlow props that make the canvas interactive, and the handlers
 *      that rewrite the diagram, are all derived from `readOnly` -- because
 *      those are not controls at all and no `disabled` audit would see them.
 */

import { describe, expect, it } from 'vitest'

/**
 * Files exempt from the control audit, with a reason each.
 *
 * Deliberately a deny-list, not an allow-list: every component is audited
 * unless it is named here. An allow-list only covers files somebody remembered
 * to add, so a brand new component full of ungated inputs would sail past it --
 * which is the one thing this test exists to prevent.
 */
const NOT_EDITING: Record<string, string> = {
  'DiagramBar.tsx':
    'the diagram bar itself -- Take, Release and the picker must stay live ' +
    'precisely when you do not hold the diagram',
  'ui.tsx': 'the modal shell; its buttons close the modal',
}

/**
 * Raw controls that are deliberately live while read-only, because they change
 * what you are looking at rather than the diagram. Each needs a reason.
 */
const VIEW_ONLY: Record<string, string> = {
  "PIDToolbar.tsx:onModeChange('pan')": 'pan vs box-select, a view mode',
  "PIDToolbar.tsx:onModeChange('select')": 'pan vs box-select, a view mode',
  'PIDToolbar.tsx:onClick={fitView}': 'recentres the viewport',
  'PIDToolbar.tsx:onClick={exportJSON}': 'downloads the diagram as a file',
  'PIDToolbar.tsx:onClick={openHistory}': 'opens the history panel',
  'PIDToolbar.tsx:setShowHistory(false)': 'closes the history panel',
  'PIDToolbar.tsx:setShowRelease(false)': 'closes the release dialog',
  'PIDToolbar.tsx:setRelLabel': 'the label field inside the release dialog, which Release already gates',
  'PIDToolbar.tsx:onClick={submitRelease}': 'inside the release dialog, which Release already gates',
  'PIDDesigner.tsx:setUnshared(null)': 'dismisses the "no longer shared" notice',
  'PIDDesigner.tsx:setShowChange(true)': 'opens the Change dialog (rename/share/copy are not gated by design)',
}

/**
 * ReactFlow props and diagram-mutating handlers that must be derived from
 * `readOnly`. These are not controls, so the tag audit cannot see them: the
 * canvas is made inert by props, and the toolbar's actions run through refs.
 */
const MUST_DERIVE_FROM_READONLY = [
  'nodesDraggable',
  'nodesConnectable',
  'elementsSelectable',
  'edgesReconnectable',
  'deleteKeyCode',
  'loadRef.current',
  'clearRef.current',
  'undoRef.current',
  'redoRef.current',
  'restoreMicroRef.current',
  'restoreReleaseRef.current',
]

const raw = import.meta.glob('../components/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

/**
 * Source with comments blanked out, same length so offsets still line up.
 * These files discuss their own controls, and a comment naming one is not one.
 * `//` only counts when it does not follow a colon, so `https://` survives.
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

/** The full opening tag, not just up to the first `>` -- an arrow function in
 *  an onClick contains one and would truncate it. */
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

function excuseFor(file: string, tag: string): string | null {
  for (const key of Object.keys(VIEW_ONLY)) {
    const i = key.indexOf(':')
    if (key.slice(0, i) === file && tag.includes(key.slice(i + 1))) return key
  }
  return null
}

describe('every diagram-editing control is gated on the checkout', () => {
  it('leaves no ungated button, input or select in the editing chrome', () => {
    const offenders: string[] = []
    for (const [path, src] of Object.entries(files)) {
      const name = path.split('/').pop()!
      if (name in NOT_EDITING) continue
      for (const tag of ['button', 'input', 'select', 'textarea']) {
        for (const text of openingTags(src, tag)) {
          if (/\breadOnly\b/.test(text)) continue
          if (excuseFor(name, text)) continue
          offenders.push(`${name}  ${text.replace(/\s+/g, ' ').slice(0, 100)}`)
        }
      }
    }
    expect(offenders, `ungated controls:\n${offenders.join('\n')}`).toEqual([])
  })

  it('derives the canvas props and the diagram-rewriting handlers from readOnly', () => {
    const src = Object.entries(files).find(([p]) => p.endsWith('/PIDDesigner.tsx'))?.[1]
    expect(src, 'PIDDesigner.tsx not found').toBeTruthy()

    const ungated = MUST_DERIVE_FROM_READONLY.filter((name) => {
      // The statement or JSX prop that assigns it, up to the end of its line
      // for a prop, or its useCallback dependency list for a handler.
      const at = src!.indexOf(name)
      if (at === -1) return true
      const window = src!.slice(at, at + 400)
      return !/\breadOnly\b/.test(window)
    })
    expect(
      ungated,
      `not derived from readOnly (a viewer could still change the diagram):\n${ungated.join('\n')}`,
    ).toEqual([])
  })

  it('keeps every exemption pointing at a real file', () => {
    const stale = Object.keys(NOT_EDITING).filter(
      (file) => !Object.keys(files).some((p) => p.endsWith(`/${file}`)),
    )
    expect(stale, `NOT_EDITING names files that no longer exist: ${stale.join(', ')}`).toEqual([])
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

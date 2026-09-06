/**
 * Every control that edits the design must be gated on the checkout.
 *
 * A design is editable only while it is checked out to you. That is enforced on
 * the server, but the server refusing a save is the *last* line -- if a control
 * stays clickable, the user edits, nothing persists, and the design appears to
 * lose their work. Exactly that shipped once: `+ Add sweep` was a `<Button>`,
 * `<Button>` was not gated, and nothing noticed.
 *
 * This is a source audit rather than a rendering test, in the same style as
 * theme.test.ts. It cannot know what a control *means*, so it enforces the one
 * thing it can check mechanically: in every component except the few exempted
 * below, each raw interactive element carries a `disabled` (or is one of the
 * shared primitives, which consult the read-only context themselves). Anything
 * genuinely view-only is listed with a reason, which keeps the exceptions
 * honest and visible.
 *
 * Note the rule here is "carries a `disabled` or `readOnly`", looser than
 * EngineDesign's equivalent, which demands the word `readOnly` in the tag. The
 * difference is deliberate: this app gates inside its primitives via
 * `useDisabled`, so `<NumberInput disabled={busy}>` is already gated and
 * demanding `readOnly` at the call site would flag every one of them.
 */

import { describe, expect, it } from 'vitest'

/**
 * Files exempt from the audit, with a reason each.
 *
 * Deliberately a deny-list. This used to name the three tabs that receive
 * `onChange={setUi}`, which meant a brand new editing component -- a fourth tab,
 * a panel split out of an existing one -- was unaudited until somebody
 * remembered to widen the pattern. Nobody would. Everything under components/
 * is audited now unless it is named here.
 */
const NOT_EDITING: Record<string, string> = {
  'ui.tsx':
    'the gated primitives themselves; Button/NumberInput/Select consult ' +
    'useDisabled, which is what the last test below pins',
  'ConfigVersions.tsx':
    'the designs bar -- Take, Release and the picker have to stay live ' +
    'precisely when you do not hold the design',
  'TemperatureByMonth.tsx': 'an atmosphere chart; picking a month changes the plot, not the design',
}

/**
 * Raw controls that are deliberately live while read-only, because they change
 * what you are looking at rather than the design. Each needs a reason.
 */
const VIEW_ONLY: Record<string, string> = {
  'RecoveryPanel.tsx:live': 'live-rerun toggle, a view preference',
  'ResultsPanel.tsx:onChange(id)': 'which case the results show',
  'CornersPanel.tsx:setKase(id)': 'which case the chart shows',
  'WorstCards.tsx:onSelect(w.id)': 'chart selection, local state',
  'StudyTable.tsx:onToggle(p.id)': 'chart series visibility, local state',
}

const files = import.meta.glob('../components/**/*.tsx', {
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

describe('checkout gating', () => {
  it('leaves no ungated raw control in the tabs that edit the design', () => {
    const offenders: string[] = []
    for (const [path, src] of Object.entries(files)) {
      const name = path.split('/').pop() as string
      if (name in NOT_EDITING) continue
      for (const tag of ['button', 'input', 'select']) {
        for (const open of openingTags(src, tag)) {
          if (/\bdisabled\s*=/.test(open) || /readOnly/.test(open)) continue
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

  it('keeps every exemption pointing at a real file', () => {
    const stale = Object.keys(NOT_EDITING).filter(
      (file) => !Object.keys(files).some((p) => p.endsWith(`/${file}`)),
    )
    expect(stale).toEqual([])
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

  it('gates Button by default, so a new one cannot escape', () => {
    const ui = Object.entries(files).find(([p]) => p.endsWith('/ui.tsx'))?.[1] ?? ''
    const body = ui.slice(ui.indexOf('export function Button'))
    // `action` is the opt-out for Run/Export; the default must be gated.
    expect(body).toMatch(/action\s*=\s*false/)
    expect(body).toMatch(/ownDisabled\s*\|\|\s*\(!action\s*&&\s*readOnly\)/)
  })
})

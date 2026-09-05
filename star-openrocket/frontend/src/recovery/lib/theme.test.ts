/**
 * The dark theme has to stay readable.
 *
 * Two regressions are easy to introduce and hard to notice in review, because
 * both look fine in a diff and only show up on a real monitor:
 *
 *   1. A text colour dark enough to disappear into the background. The muted
 *      tier shipped at #64748b, which is 3.6:1 against the inset panels it sat
 *      on -- under the 4.5:1 WCAG AA floor -- and it happened to be the tier
 *      carrying the SMALLEST text in the app.
 *   2. A font size small enough to be unreadable. The same tier was 10px.
 *
 * These assert the values in index.css directly rather than a copy of them,
 * so the test fails if someone edits the stylesheet, not if someone forgets to
 * update a duplicate table here.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(
  fileURLToPath(new URL('../../index.css', import.meta.url)),
  'utf8',
)

/** Pull `--name: value;` out of the stylesheet.
 *
 *  The leading `(?<![-\w])` matters: without it, looking up `--text-primary`
 *  happily matches the tail of `--color-text-primary`, so a typo'd name finds
 *  the wrong declaration instead of failing. */
function cssVar(name: string): string {
  const m = CSS.match(new RegExp(`(?<![-\\w])--${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`--${name} is not defined in index.css`)
  return m[1].trim()
}

/** Colour tokens are all under the `--color-` namespace. */
const colour = (name: string) => cssVar(`color-${name}`)

/** WCAG 2.1 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `0.875rem` -> 14. The scale is written in rem against a 16px root. */
function rem2px(value: string): number {
  const m = value.match(/^([\d.]+)rem$/)
  if (!m) throw new Error(`expected a rem value, got ${value}`)
  return Number(m[1]) * 16
}

describe('the stylesheet parses', () => {
  // This suite exists because the contrast tests above are regex-based and so
  // will happily read a value out of a stylesheet the *browser* has thrown
  // away. A stray `*/` left in the `:root` block once invalidated every
  // declaration above it -- backgrounds and --color-text-primary among them --
  // and the page rendered black text on black, while every assertion here
  // still passed. Structure has to be checked separately from content.

  it('has balanced comment delimiters', () => {
    const opens = CSS.match(/\/\*/g)?.length ?? 0
    const closes = CSS.match(/\*\//g)?.length ?? 0
    expect(closes, 'unbalanced /* */ in index.css').toBe(opens)
  })

  it('has nothing but declarations inside :root', () => {
    const block = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/:root\s*\{([\s\S]*?)\}/)
    expect(block, ':root block not found').not.toBeNull()
    const stray = block![1]
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^--[\w-]+:\s*\S/.test(s))
    expect(stray, 'non-declaration text inside :root').toEqual([])
  })

  it('declares every colour the app references', () => {
    // A `var(--color-x)` with no `--color-x` behind it does not fall back --
    // it resolves to nothing, which for a fill or a colour means black.
    const files = import.meta.glob('../**/*.{ts,tsx}', {
      eager: true, query: '?raw', import: 'default',
    }) as Record<string, string>
    const referenced = new Set<string>()
    for (const src of Object.values(files)) {
      for (const m of src.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) referenced.add(m[1])
    }
    const missing = [...referenced].filter(
      (name) => !new RegExp(`(?<![-\\w])${name}:`).test(CSS),
    )
    expect(missing, 'referenced but never declared').toEqual([])
  })
})

const TEXT = ['text-primary', 'text-secondary', 'text-muted']
// Every surface text is drawn on. `bg-tertiary` is the lightest -- the inset
// panels inside a card -- so it is the worst case for a light-on-dark palette,
// and the one worth asserting against.
const BG = ['bg-primary', 'bg-secondary', 'bg-tertiary']

describe('contrast', () => {
  it('sanity-checks the ratio function against known WCAG values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // Symmetric: order of arguments must not matter.
    expect(contrast('#0a0a0f', '#f8fafc')).toBeCloseTo(
      contrast('#f8fafc', '#0a0a0f'), 10)
  })

  it('clears AAA for every text tier on every background', () => {
    for (const text of TEXT) {
      for (const bg of BG) {
        const ratio = contrast(colour(text), colour(bg))
        expect(
          ratio,
          `--color-${text} on --color-${bg} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('keeps the three text tiers visually distinct', () => {
    // Passing contrast is not enough on its own: three tiers that all clear
    // 7:1 by converging on white would satisfy the test above while destroying
    // the hierarchy the tiers exist to express.
    const lum = TEXT.map((t) => luminance(colour(t)))
    for (let i = 1; i < lum.length; i++) {
      expect(lum[i - 1]).toBeGreaterThan(lum[i])
      expect(contrast(colour(TEXT[i - 1]), colour(TEXT[i]))).toBeGreaterThan(1.2)
    }
  })

  it('keeps borders visible against the cards they divide', () => {
    // Not a text rule -- 3:1 is the WCAG floor for non-text UI boundaries.
    expect(contrast(colour('border'), colour('bg-secondary')))
      .toBeGreaterThanOrEqual(1.4)
  })
})

describe('type scale', () => {
  const SCALE = ['text-2xs', 'text-xs', 'text-sm', 'text-base', 'text-lg']

  it('never drops below 13px', () => {
    for (const step of SCALE) {
      const px = rem2px(cssVar(step))
      expect(px, `--${step} is ${px}px`).toBeGreaterThanOrEqual(13)
    }
  })

  it('increases monotonically', () => {
    const px = SCALE.map((s) => rem2px(cssVar(s)))
    for (let i = 1; i < px.length; i++) {
      expect(px[i]).toBeGreaterThan(px[i - 1])
    }
  })

  it('has no arbitrary font sizes left in the components', () => {
    // `text-[10px]` and friends do not track the scale above, so a single one
    // reintroduces exactly the tier this change removed.
    const files = import.meta.glob('../**/*.tsx', {
      eager: true, query: '?raw', import: 'default',
    }) as Record<string, string>
    const offenders = Object.entries(files)
      .filter(([, src]) => /text-\[[\d.]+px\]/.test(src))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})

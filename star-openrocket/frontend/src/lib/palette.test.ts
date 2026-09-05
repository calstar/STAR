/**
 * One palette, not two.
 *
 * This app was assembled by merging an Onshape CAD viewer with the recovery
 * calculator. The viewer half was written in raw Tailwind slate and cyan, the
 * recovery half against the `--color-*` tokens shared with EngineDesign and
 * pid-designer. For a while both shipped, which is how the header came to show
 * two different accents an inch apart -- a cyan active tab above a blue
 * Take button.
 *
 * The migration is mechanical and so is the way it rots: someone adds a panel,
 * reaches for `bg-slate-800` because that is what the file above it used to
 * say, and the split quietly reopens. These tests are the ratchet.
 *
 * Sibling to recovery/lib/theme.test.ts, which guards the token *values*
 * (contrast); this one guards that the tokens are what gets used at all.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Scene.tsx is exempt, deliberately. Its colours are three.js material values
 * for geometry in a 3D viewport -- a selection highlight that has to read
 * against the default part grey, plus the violet/orange/fuchsia face
 * highlights. They are tuned for legibility against rendered surfaces, not for
 * agreement with the surrounding chrome, and they are not Tailwind classes.
 */
const EXEMPT = /Scene\.tsx$/

const sources = import.meta.glob('../{components,recovery}/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const appSources = Object.entries(sources).filter(([p]) => !EXEMPT.test(p))

describe('one palette', () => {
  it('audits a non-empty set of files', () => {
    // A glob that silently matched nothing would make everything below pass.
    expect(appSources.length).toBeGreaterThan(30)
  })

  it('has no Tailwind slate or cyan utility classes left', () => {
    const offenders: string[] = []
    for (const [path, src] of appSources) {
      // Class usages only. A hex in a chart-series table or the word "slate"
      // in a comment is not a utility class and is not what this guards.
      for (const m of src.matchAll(
        /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|accent|fill|stroke|divide|from|to|via|outline|placeholder|caret|shadow)-(?:slate|cyan)-\d+(?:\/\d+)?/g,
      )) {
        offenders.push(`${path.split('/').pop()}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * Recharts writes most of these through as SVG presentation attributes, where
 * `var()` does not resolve — so the chart themes carry literal hexes that
 * duplicate the tokens. Nothing in the compiler connects the two, so this is
 * the only thing that keeps them in step when a token is retuned.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../index.css', import.meta.url)),
  'utf8',
)

function token(name: string): string {
  const m = CSS.match(new RegExp(`(?<![-\\w])--color-${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`--color-${name} is not defined in index.css`)
  return m[1].trim()
}

const themes = import.meta.glob('../{components/viewer,recovery/components}/chartTheme.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

describe('chart chrome mirrors the tokens', () => {
  it('finds both chart themes', () => {
    expect(Object.keys(themes)).toHaveLength(2)
  })

  it.each([
    ['axis stroke', /AXIS = \{\s*stroke: '(#[0-9a-f]{6})'/, 'text-muted'],
    ['grid stroke', /GRID = \{\s*stroke: '(#[0-9a-f]{6})'/, 'border'],
    ['tooltip background', /TOOLTIP_STYLE = \{\s*backgroundColor: '(#[0-9a-f]{6})'/, 'bg-secondary'],
  ])('%s equals --color-%s in both themes', (_label, pattern, name) => {
    for (const [path, src] of Object.entries(themes)) {
      const m = src.match(pattern)
      expect(m, `${path} has no match for ${pattern}`).not.toBeNull()
      expect(m![1]).toBe(token(name as string))
    }
  })
})

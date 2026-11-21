/**
 * The icons are bundled through import.meta.glob (so a host app gets them too),
 * and pix() returns '' for a name it does not know -- a broken image, silently.
 * Every icon name the sources spell must therefore be one the glob found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { componentIcon, pix } from './icons'
import type { ComponentType } from '../types'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'assets' ? [] : sources(p)
    return /\.tsx?$/.test(n) && !n.endsWith('.test.ts') ? [p] : []
  })
}

describe('pix', () => {
  it('resolves a known icon to a URL and an unknown one to nothing', () => {
    expect(pix('icons/edit-undo.png')).not.toBe('')
    expect(pix('icon-064.png')).not.toBe('')
    expect(pix('icons/no-such-icon.png')).toBe('')
  })

  it('finds every icon the sources name', () => {
    const names = new Set<string>()
    for (const f of sources(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`]((?:icons|componenticons|eventicons)\/[\w.-]+\.png)['"`]/g)) names.add(m[1])
    }
    expect(names.size).toBeGreaterThan(20)
    const missing = [...names].filter((n) => pix(n) === '')
    expect(missing).toEqual([])
  })

  it('has both sizes of every component icon', () => {
    const types: ComponentType[] = ['stage', 'nosecone', 'bodytube', 'transition', 'trapezoidfinset', 'ellipticalfinset',
      'freeformfinset', 'tubefinset', 'launchlug', 'railbutton', 'innertube', 'tubecoupler', 'centeringring', 'bulkhead',
      'engineblock', 'masscomponent', 'shockcord', 'parachute', 'streamer', 'parallelstage', 'podset']
    for (const t of types) for (const size of ['small', 'large'] as const) expect(componentIcon(t, size), `${t} ${size}`).toBeTruthy()
  })
})

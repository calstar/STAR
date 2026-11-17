import { describe, expect, it } from 'vitest'
import { addTarget, isCompatible } from './rules'
import { SIMPLE_ROCKET, ID } from '../api/fixture'
import { findById } from './tree'
import type { ComponentType } from '../types'

const ALL: ComponentType[] = [
  'rocket', 'stage', 'parallelstage', 'podset', 'nosecone', 'bodytube', 'transition',
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'masscomponent', 'shockcord', 'parachute', 'streamer',
]

const allowed = (p: ComponentType) => ALL.filter((c) => isCompatible(p, c)).sort()

describe('isCompatible (OpenRocket 24.12 isCompatible)', () => {
  it('rocket takes exactly AxialStage', () => {
    expect(allowed('rocket')).toEqual(['stage'])
  })
  it('stage, boosters and pods take body components only', () => {
    for (const a of ['stage', 'parallelstage', 'podset'] as const) {
      expect(allowed(a)).toEqual(['bodytube', 'nosecone', 'transition'])
    }
  })
  it('body tube: boosters, pods, internals and non-body externals', () => {
    expect(allowed('bodytube')).toEqual([
      'bulkhead', 'centeringring', 'ellipticalfinset', 'engineblock', 'freeformfinset', 'innertube', 'launchlug',
      'masscomponent', 'parachute', 'parallelstage', 'podset', 'railbutton', 'shockcord', 'streamer',
      'trapezoidfinset', 'tubecoupler', 'tubefinset',
    ])
  })
  it('nose cone and transition: internals plus freeform fins only', () => {
    for (const t of ['nosecone', 'transition'] as const) {
      expect(allowed(t)).toContain('freeformfinset')
      expect(allowed(t)).not.toContain('trapezoidfinset')
      expect(allowed(t)).not.toContain('launchlug')
      expect(allowed(t)).toContain('parachute')
    }
  })
  it('inner tube and coupler take internals; leaves take nothing', () => {
    expect(allowed('innertube')).toEqual(allowed('tubecoupler'))
    expect(allowed('innertube')).toContain('engineblock')
    for (const leaf of ['trapezoidfinset', 'launchlug', 'centeringring', 'bulkhead', 'engineblock', 'parachute', 'masscomponent', 'shockcord', 'streamer', 'railbutton', 'tubefinset'] as const) {
      expect(allowed(leaf)).toEqual([])
    }
  })
})

describe('addTarget (ComponentButton / BodyComponentButton / StageButton)', () => {
  const root = SIMPLE_ROCKET.rocket
  const sel = (id: string) => findById(root, id)

  it('nothing selected: body components go to the end of the last stage; others are disabled', () => {
    expect(addTarget(root, null, 'bodytube')).toEqual({ parentId: ID.stage, index: null, ask: false })
    expect(addTarget(root, null, 'trapezoidfinset')).toBeNull()
    expect(addTarget(root, null, 'stage')).toEqual({ parentId: ID.rocket, index: null, ask: false })
  })
  it('rocket selected: fins disabled, body to last stage', () => {
    expect(addTarget(root, root, 'trapezoidfinset')).toBeNull()
    expect(addTarget(root, root, 'nosecone')?.parentId).toBe(ID.stage)
  })
  it('compatible selection becomes the parent', () => {
    expect(addTarget(root, sel(ID.body), 'trapezoidfinset')).toEqual({ parentId: ID.body, index: null, ask: false })
    expect(addTarget(root, sel(ID.mmt), 'engineblock')?.parentId).toBe(ID.mmt)
    expect(addTarget(root, sel(ID.nose), 'freeformfinset')?.parentId).toBe(ID.nose)
  })
  it('body component next to a body component: same parent, ask when not last', () => {
    // nose is first of two -> ask, "insert here" is right after it
    expect(addTarget(root, sel(ID.nose), 'transition')).toEqual({ parentId: ID.stage, index: 1, ask: true })
    // body tube is last -> append without asking
    expect(addTarget(root, sel(ID.body), 'bodytube')).toEqual({ parentId: ID.stage, index: null, ask: false })
  })
  it('incompatible non-body selection disables', () => {
    expect(addTarget(root, sel(ID.fins), 'parachute')).toBeNull()
    expect(addTarget(root, sel(ID.chute), 'bodytube')).toBeNull()
    expect(addTarget(root, sel(ID.nose), 'trapezoidfinset')).toBeNull()
  })
  it('stage button from a deep selection appends after the last stage', () => {
    expect(addTarget(root, sel(ID.block), 'stage')).toEqual({ parentId: ID.rocket, index: null, ask: false })
  })
})

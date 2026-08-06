/**
 * Corner labelling, and the colour rules the chart depends on.
 *
 * The label is the only thing tying a line in the legend to a row in the table
 * and a chip on a worst-case card. If it renders two ways, a reader comparing
 * the chart against the table is comparing two different corners without any
 * signal that they differ.
 */

import { describe, expect, it } from 'vitest'

import { cornerLabel, cornerPart, orderedKeys } from './corners'
import { CONTEXT_COLOUR, CORNER_COLOURS, MAX_SELECTED, colourFor } from '../components/chartTheme'

/** A corner as /api/sweep sends it. */
const CORNER = { Cx: 1.8, n: 6.0, CdS_body: 0.0048643918, v_rel: 5.0, delay: 0.0 }

describe('corner labels', () => {
  it('never shows the airframe as a raw drag area', () => {
    // 0.00486 m2 says nothing about which way the vehicle is pointing, and the
    // attitude band is the single largest term in the model.
    const label = cornerLabel(CORNER, 'axial')
    expect(label).toContain('axial')
    expect(label).not.toContain('0.0048')
    expect(cornerPart('CdS_body', CORNER.CdS_body, 'broadside')).toBe('broadside')
  })

  it('trims trailing zeros so a legend stays narrow', () => {
    expect(cornerPart('n', 6.0)).toBe('n6')
    expect(cornerPart('Cx', 1.8)).toBe('Cx1.8')
    expect(cornerPart('delay', 0.0)).toBe('Δt0')
  })

  it('orders keys the same way regardless of payload key order', () => {
    const shuffled = { delay: 0, Cx: 1.8, v_rel: 5, n: 6, CdS_body: 0.00486 }
    expect(orderedKeys(shuffled)).toEqual(orderedKeys(CORNER))
    expect(cornerLabel(shuffled, 'axial')).toBe(cornerLabel(CORNER, 'axial'))
  })

  it('shows a parameter it has never heard of rather than dropping it', () => {
    // A new swept key must not vanish from the UI just because this table has
    // not been updated -- silently under-reporting the sweep is the failure.
    const label = cornerLabel({ ...CORNER, wind: 3 }, 'axial')
    expect(label).toContain('wind3')
  })
})

describe('corner colours', () => {
  it('has enough distinct hues for the selection cap', () => {
    expect(CORNER_COLOURS).toHaveLength(MAX_SELECTED)
    expect(new Set(CORNER_COLOURS).size).toBe(CORNER_COLOURS.length)
    expect(CORNER_COLOURS).not.toContain(CONTEXT_COLOUR)
  })

  it('assigns colour by selection order, not by table position', () => {
    const sel = ['c7', 'c2', 'c19']
    expect(colourFor(sel, 'c7')).toBe(CORNER_COLOURS[0])
    expect(colourFor(sel, 'c2')).toBe(CORNER_COLOURS[1])
    expect(colourFor(sel, 'c19')).toBe(CORNER_COLOURS[2])
  })

  it('keeps a corner its colour when a LATER one is removed', () => {
    // Colour follows the corner, never its rank. Repainting survivors when the
    // selection changes makes two screenshots of the same sweep disagree.
    const before = ['c7', 'c2', 'c19']
    const after = ['c7', 'c2']
    expect(colourFor(after, 'c7')).toBe(colourFor(before, 'c7'))
    expect(colourFor(after, 'c2')).toBe(colourFor(before, 'c2'))
  })

  it('gives unselected corners the anonymous context grey', () => {
    expect(colourFor(['c1'], 'c9')).toBe(CONTEXT_COLOUR)
  })
})

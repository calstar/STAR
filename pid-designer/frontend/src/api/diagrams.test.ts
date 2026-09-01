/**
 * What actually gets stored when a diagram is saved.
 *
 * ReactFlow hangs view state off every node -- `selected` flips on a plain
 * click, `dragging` is transient, `measured` is a layout measurement it
 * recomputes anyway. Persisting those meant *looking* at a diagram rewrote it:
 * a click produced a new payload, the autosave debounce stored it, and version
 * history filled with snapshots differing only in what someone had highlighted.
 *
 * The property under test is the one that matters for checkouts too: a
 * selection-only change must be a no-op, because a save is what will keep a
 * checkout alive.
 */

import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { toStored } from './diagrams'

/** Shaped like the committed sample in pid-designer/diagrams/pid_main.json. */
const node = (over: Partial<Node> = {}): Node =>
  ({
    id: 'node_1',
    type: 'RTD',
    position: { x: 840, y: -220 },
    data: { componentType: 'RTD', label: 'RTD_#', fluidType: 'default' },
    measured: { width: 60, height: 60 },
    selected: false,
    dragging: false,
    ...over,
  }) as Node

const edge = (over: Partial<Edge> = {}): Edge =>
  ({ id: 'e1', source: 'node_1', target: 'node_2', selected: false, ...over }) as Edge

describe('toStored', () => {
  it('drops the view state ReactFlow adds', () => {
    const [out] = toStored({ nodes: [node()], edges: [] }).nodes
    expect(Object.keys(out).sort()).toEqual(['data', 'id', 'position', 'type'])
  })

  it('keeps everything authored', () => {
    const [out] = toStored({ nodes: [node()], edges: [] }).nodes
    expect(out.data).toEqual({ componentType: 'RTD', label: 'RTD_#', fluidType: 'default' })
    expect(out.position).toEqual({ x: 840, y: -220 })
    expect(out.type).toBe('RTD')
  })

  it('makes a selection-only change a no-op', () => {
    const before = toStored({ nodes: [node()], edges: [edge()] })
    const after = toStored({
      nodes: [node({ selected: true })],
      edges: [edge({ selected: true })],
    })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('makes a drag-in-progress flag a no-op', () => {
    const before = toStored({ nodes: [node()], edges: [] })
    const after = toStored({ nodes: [node({ dragging: true })], edges: [] })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('still notices a real edit', () => {
    const before = toStored({ nodes: [node()], edges: [] })
    const moved = toStored({ nodes: [node({ position: { x: 0, y: 0 } })], edges: [] })
    expect(JSON.stringify(moved)).not.toBe(JSON.stringify(before))
  })

  it('drops selected from edges too', () => {
    const [out] = toStored({ nodes: [], edges: [edge({ selected: true })] }).edges
    expect('selected' in out).toBe(false)
    expect(out.source).toBe('node_1')
  })
})

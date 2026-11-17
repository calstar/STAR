import { describe, expect, it } from 'vitest'
import { canRedo, canUndo, HISTORY_LIMIT, initHistory, push, redo, redoLabel, seal, undo, undoLabel } from './history'

describe('undo stack', () => {
  it('undoes and redoes in order', () => {
    let h = initHistory(0)
    h = push(h, 1, { label: 'one', now: 0 })
    h = push(h, 2, { label: 'two', now: 5000 })
    expect(h.present).toBe(2)
    expect(undoLabel(h)).toBe('two')
    h = undo(h)
    expect(h.present).toBe(1)
    expect(redoLabel(h)).toBe('two')
    h = undo(h)
    expect(h.present).toBe(0)
    expect(canUndo(h)).toBe(false)
    h = redo(h)
    expect(h.present).toBe(1)
    h = redo(h)
    expect(h.present).toBe(2)
    expect(canRedo(h)).toBe(false)
  })

  it('a new edit after undo drops the redo branch', () => {
    let h = push(push(initHistory('a'), 'b', { now: 0 }), 'c', { now: 5000 })
    h = undo(h)
    h = push(h, 'd', { now: 9000 })
    expect(h.present).toBe('d')
    expect(canRedo(h)).toBe(false)
    expect(undo(h).present).toBe('b')
  })

  it('coalesces same-key edits inside the window into one step', () => {
    let h = initHistory(0)
    h = push(h, 1, { key: 'len', now: 0 })
    h = push(h, 12, { key: 'len', now: 300 })
    h = push(h, 125, { key: 'len', now: 600 })
    expect(h.past).toEqual([0])
    expect(undo(h).present).toBe(0)
  })

  it('does not coalesce across keys, outside the window, or after seal', () => {
    let h = initHistory(0)
    h = push(h, 1, { key: 'a', now: 0 })
    h = push(h, 2, { key: 'b', now: 10 })
    expect(h.past).toEqual([0, 1])
    h = push(h, 3, { key: 'b', now: 5000 })
    expect(h.past).toEqual([0, 1, 2])
    h = seal(h)
    h = push(h, 4, { key: 'b', now: 5001 })
    expect(h.past).toEqual([0, 1, 2, 3])
  })

  it('ignores a push of the identical value and caps its length', () => {
    let h = initHistory({ v: 0 })
    expect(push(h, h.present)).toBe(h)
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = push(h, { v: i }, { now: i * 10000 })
    expect(h.past.length).toBe(HISTORY_LIMIT)
    expect(h.pastLabels.length).toBe(HISTORY_LIMIT)
  })

  it('undo on an empty history is a no-op', () => {
    const h = initHistory(1)
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
  })
})

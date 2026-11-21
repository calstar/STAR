import { describe, expect, it } from 'vitest'
import { SIMPLE_ROCKET, ID } from '../api/fixture'
import { canMove, findById, findParent, insertChild, moveSibling, removeById, updateById, withFreshIds, allIds } from './tree'

const root = SIMPLE_ROCKET.rocket

describe('tree ops', () => {
  it('finds and parents', () => {
    expect(findById(root, ID.block)?.name).toBe('Engine block')
    expect(findParent(root, ID.block)?.id).toBe(ID.mmt)
  })
  it('updates immutably, sharing untouched subtrees', () => {
    const n = updateById(root, ID.fins, (c) => ({ ...c, name: 'Fins' }))
    expect(findById(n, ID.fins)?.name).toBe('Fins')
    expect(findById(root, ID.fins)?.name).toBe('Trapezoidal fin set')
    expect(findById(n, ID.mmt)).toBe(findById(root, ID.mmt))
  })
  it('moves within siblings and stops at the ends', () => {
    const body = findById(root, ID.body)!
    expect(body.children[0].id).toBe(ID.chute)
    const n = moveSibling(root, ID.chute, 1)
    expect(findById(n, ID.body)!.children.map((c) => c.id).slice(0, 2)).toEqual([ID.cord, ID.chute])
    expect(moveSibling(root, ID.chute, -1)).toBe(root)
    expect(canMove(root, ID.chute, -1)).toBe(false)
    expect(canMove(root, ID.mmt, 1)).toBe(false)
  })
  it('inserts and removes', () => {
    const extra = { id: 'x', type: 'bulkhead' as const, name: 'B', params: {}, children: [] }
    const n = insertChild(root, ID.body, extra, 1)
    expect(findById(n, ID.body)!.children[1].id).toBe('x')
    expect(findById(removeById(n, 'x'), 'x')).toBeNull()
    expect(findById(removeById(root, ID.mmt), ID.block)).toBeNull()
  })
  it('fresh ids are unique and new', () => {
    const copy = withFreshIds(root)
    const a = allIds(root)
    for (const id of allIds(copy)) expect(a.has(id)).toBe(false)
    expect(allIds(copy).size).toBe(a.size)
  })
})

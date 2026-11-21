/**
 * Immutable operations on the component tree. Every edit returns a new root;
 * untouched subtrees are shared, so React and the undo stack stay cheap.
 */
import type { Component } from '../types'

export function walk(c: Component, fn: (c: Component, parent: Component | null, depth: number) => void,
  parent: Component | null = null, depth = 0): void {
  fn(c, parent, depth)
  for (const ch of c.children) walk(ch, fn, c, depth + 1)
}

export function findById(root: Component, id: string | null | undefined): Component | null {
  if (!id) return null
  if (root.id === id) return root
  for (const ch of root.children) {
    const f = findById(ch, id)
    if (f) return f
  }
  return null
}

export function findParent(root: Component, id: string): Component | null {
  for (const ch of root.children) {
    if (ch.id === id) return root
    const f = findParent(ch, id)
    if (f) return f
  }
  return null
}

/** Root first, the component itself last. Empty when absent. */
export function pathTo(root: Component, id: string): Component[] {
  if (root.id === id) return [root]
  for (const ch of root.children) {
    const p = pathTo(ch, id)
    if (p.length) return [root, ...p]
  }
  return []
}

export function updateById(root: Component, id: string, fn: (c: Component) => Component): Component {
  if (root.id === id) return fn(root)
  let changed = false
  const children = root.children.map((ch) => {
    const n = updateById(ch, id, fn)
    if (n !== ch) changed = true
    return n
  })
  return changed ? { ...root, children } : root
}

export function removeById(root: Component, id: string): Component {
  const idx = root.children.findIndex((c) => c.id === id)
  if (idx >= 0) return { ...root, children: root.children.filter((c) => c.id !== id) }
  let changed = false
  const children = root.children.map((ch) => {
    const n = removeById(ch, id)
    if (n !== ch) changed = true
    return n
  })
  return changed ? { ...root, children } : root
}

/** `index` null appends. */
export function insertChild(root: Component, parentId: string, child: Component, index: number | null): Component {
  return updateById(root, parentId, (p) => {
    const children = [...p.children]
    const at = index == null ? children.length : Math.max(0, Math.min(index, children.length))
    children.splice(at, 0, child)
    return { ...p, children }
  })
}

/** Moves a component one place among its siblings. No-op at either end. */
export function moveSibling(root: Component, id: string, delta: -1 | 1): Component {
  const parent = findParent(root, id)
  if (!parent) return root
  const i = parent.children.findIndex((c) => c.id === id)
  const j = i + delta
  if (j < 0 || j >= parent.children.length) return root
  return updateById(root, parent.id, (p) => {
    const children = [...p.children]
    ;[children[i], children[j]] = [children[j], children[i]]
    return { ...p, children }
  })
}

export function canMove(root: Component, id: string, delta: -1 | 1): boolean {
  const parent = findParent(root, id)
  if (!parent) return false
  const j = parent.children.findIndex((c) => c.id === id) + delta
  return j >= 0 && j < parent.children.length
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** A deep copy with fresh ids throughout (for components fetched as defaults). */
export function withFreshIds(c: Component): Component {
  return { ...c, id: newId(), params: structuredClone(c.params), children: c.children.map(withFreshIds) }
}

export function allIds(root: Component): Set<string> {
  const s = new Set<string>()
  walk(root, (c) => s.add(c.id))
  return s
}

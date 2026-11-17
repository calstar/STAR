/**
 * Which component may go under which, and where an "Add new component" button
 * puts its component. Ported from OpenRocket 24.12:
 *
 *   core/.../rocketcomponent/*.java  isCompatible(Class)
 *   swing/.../gui/main/ComponentButton.java       isAddable / getAdditionPosition
 *   swing/.../gui/main/ComponentAddButtons.java   BodyComponentButton, StageButton
 *
 * OpenRocket answers with the class hierarchy; the same hierarchy is spelled out
 * here as sets, one per abstract class the rules name.
 */
import type { Component, ComponentType } from '../types'
import { findParent, pathTo } from './tree'

/** BodyComponent: SymmetricComponent subclasses. */
export const BODY: ReadonlySet<ComponentType> = new Set(['nosecone', 'bodytube', 'transition'])

/** ExternalComponent but not BodyComponent: fin sets, lugs, rail buttons. */
export const EXTERNAL_NON_BODY: ReadonlySet<ComponentType> = new Set([
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
])

/** InternalComponent: structural rings/tubes and every MassObject. */
export const INTERNAL: ReadonlySet<ComponentType> = new Set([
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'masscomponent', 'shockcord', 'parachute', 'streamer',
])

export const ASSEMBLY: ReadonlySet<ComponentType> = new Set(['stage', 'parallelstage', 'podset'])

/** `parent.isCompatible(child)` */
export function isCompatible(parent: ComponentType, child: ComponentType): boolean {
  switch (parent) {
    case 'rocket':
      // Rocket.isCompatible: AxialStage.class.equals(type) -- exactly, so not boosters.
      return child === 'stage'
    case 'stage':
    case 'parallelstage':
    case 'podset':
      return BODY.has(child)
    case 'bodytube':
      return child === 'parallelstage' || child === 'podset' || INTERNAL.has(child) || EXTERNAL_NON_BODY.has(child)
    case 'nosecone':
    case 'transition':
      return INTERNAL.has(child) || child === 'freeformfinset'
    case 'innertube':
    case 'tubecoupler':
      return INTERNAL.has(child)
    default:
      // Fin sets, lugs, rail buttons, rings, bulkheads, engine blocks, mass objects.
      return false
  }
}

export interface AddTarget {
  parentId: string
  /** null appends at the end of the parent. */
  index: number | null
  /**
   * OpenRocket asks "Insert here / Add to the end" when the selection is not the
   * last of its siblings. When set, `index` is the "Insert here" answer and
   * appending is the other one.
   */
  ask: boolean
}

function lastStage(root: Component): Component | null {
  const stages = root.children.filter((c) => c.type === 'stage')
  return stages.length ? stages[stages.length - 1] : null
}

/**
 * Where a new `type` goes with `selected` selected, or null when the button is
 * disabled. `selected` null means nothing is selected.
 */
export function addTarget(root: Component, selected: Component | null, type: ComponentType): AddTarget | null {
  if (type === 'stage') {
    // StageButton: always enabled.
    if (!selected || selected.type === 'rocket') return { parentId: root.id, index: null, ask: false }
    const path = pathTo(root, selected.id)
    const stage = path.find((c) => c.type === 'stage' && findParent(root, c.id)?.id === root.id)
    if (!stage) return { parentId: root.id, index: null, ask: false }
    const i = root.children.findIndex((c) => c.id === stage.id)
    const isLast = i === root.children.length - 1
    return { parentId: root.id, index: isLast ? null : i + 1, ask: !isLast }
  }

  if (selected && isCompatible(selected.type, type)) {
    return { parentId: selected.id, index: null, ask: false }
  }

  if (BODY.has(type)) {
    // BodyComponentButton
    if (!selected || selected.type === 'rocket') {
      const stage = lastStage(root)
      // OpenRocket's rocket always has a stage; ours might not after a delete.
      return stage ? { parentId: stage.id, index: null, ask: false } : null
    }
    if (!BODY.has(selected.type)) return null
    const parent = findParent(root, selected.id)
    if (!parent) return null
    const i = parent.children.findIndex((c) => c.id === selected.id)
    const isLast = i === parent.children.length - 1
    return { parentId: parent.id, index: isLast ? null : i + 1, ask: !isLast }
  }

  return null
}

/** Body components and assemblies -- the things a stage strings end to end. */
export function isBody(t: ComponentType): boolean {
  return BODY.has(t)
}

export function isFinSet(t: ComponentType): boolean {
  return t === 'trapezoidfinset' || t === 'ellipticalfinset' || t === 'freeformfinset' || t === 'tubefinset'
}

/** Components that can be motor mounts in OpenRocket (MotorMount implementors). */
export function canMountMotor(t: ComponentType): boolean {
  return t === 'bodytube' || t === 'innertube'
}

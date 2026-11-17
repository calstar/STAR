/**
 * Axial position methods, ported from OpenRocket 24.12
 * core/.../rocketcomponent/position/AxialMethod.java.
 *
 * Everything here is a position of the component's FRONT relative to its
 * parent's front, in metres:
 *
 *   absolute  offset is from the rocket tip         rel = offset - parentX
 *   after     offset is from the previous sibling's aft end
 *   top       front to parent's front                rel = offset
 *   middle    middle to parent's middle              rel = offset + (P - L)/2
 *   bottom    aft end to parent's aft end            rel = offset + (P - L)
 *
 * Changing the method in OpenRocket keeps the component where it is and
 * recomputes the offset; `convertMethod` does the same.
 */
import type { AxialMethod, Position } from '../types'

export interface PositionContext {
  /** This component's length, m. */
  length: number
  /** The parent's length, m. */
  parentLength: number
  /** The parent's front, absolute from the tip, m. */
  parentX: number
  /** The previous sibling's aft end, relative to the parent's front, m (0 when first). */
  prevEnd: number
}

export const AXIAL_METHODS: { value: AxialMethod; label: string }[] = [
  // Labels: messages.properties RocketComponent.Position.Method.Axial.*
  { value: 'top', label: 'Top of the parent component' },
  { value: 'middle', label: 'Middle of the parent component' },
  { value: 'bottom', label: 'Bottom of the parent component' },
  { value: 'absolute', label: 'Tip of the rocket' },
  { value: 'after', label: 'After the sibling component' },
]

/** Front of the component relative to the parent's front. */
export function relativePosition(pos: Position, ctx: PositionContext): number {
  const { length: L, parentLength: P } = ctx
  switch (pos.method) {
    case 'absolute':
      return pos.value - ctx.parentX
    case 'after':
      return ctx.prevEnd + pos.value
    case 'top':
      return pos.value
    case 'middle':
      return pos.value + (P - L) / 2
    case 'bottom':
      return pos.value + (P - L)
  }
}

/** The offset that puts the component's front at `rel` under `method`. */
export function offsetFor(method: AxialMethod, rel: number, ctx: PositionContext): number {
  const { length: L, parentLength: P } = ctx
  switch (method) {
    case 'absolute':
      return rel + ctx.parentX
    case 'after':
      return rel - ctx.prevEnd
    case 'top':
      return rel
    case 'middle':
      return rel - (P - L) / 2
    case 'bottom':
      return rel - (P - L)
  }
}

/** Same place, new method: what OpenRocket does when the dropdown changes. */
export function convertMethod(pos: Position, method: AxialMethod, ctx: PositionContext): Position {
  const rel = relativePosition(pos, ctx)
  const value = offsetFor(method, rel, ctx)
  // Kill float dust so "0" does not come back as 1e-17.
  return { method, value: Math.abs(value) < 1e-12 ? 0 : value }
}

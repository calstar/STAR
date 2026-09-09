import type { ReactNode } from 'react';

/**
 * Lettering inside a symbol that has been turned.
 *
 * Rotating a part is about pointing it somewhere. Its lettering should still
 * read left to right afterwards, so this undoes the symbol's rotation about
 * the same centre: an annotation swings round to stay beside the thing it
 * labels, but never ends up sideways or upside down.
 */
export function Upright({ rotation = 0, cx, cy, children }: {
  rotation?: number;
  cx: number;
  cy: number;
  children: ReactNode;
}) {
  if (!rotation) return <>{children}</>;
  return <g transform={`rotate(${-rotation} ${cx} ${cy})`}>{children}</g>;
}

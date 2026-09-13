import type { ReactNode } from 'react';

/**
 * Lettering inside a symbol that has been turned.
 *
 * Rotating a part is about pointing it somewhere. Its lettering should still
 * read left to right afterwards — but it should also stay on the thing it
 * labels, and those are two different requirements.
 *
 * So the counter-rotation is about the text's **own anchor**, not the symbol's
 * centre. About the centre it cancelled the turn completely and snapped the
 * text back to where it would have been unturned: a solenoid's `S` flew off
 * its actuator and sat above the bowtie the moment the valve was rotated,
 * with the actuator itself over on the right. About its own anchor the text
 * stays exactly where the rotation carried it and only spins upright.
 */
export function Upright({ rotation = 0, x, y, children }: {
  rotation?: number;
  /** The anchor the text is drawn at, in the symbol's own coordinates. */
  x: number;
  y: number;
  children: ReactNode;
}) {
  if (!rotation) return <>{children}</>;
  return <g transform={`rotate(${-rotation} ${x} ${y})`}>{children}</g>;
}

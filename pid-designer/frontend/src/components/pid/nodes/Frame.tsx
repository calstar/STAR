import { Position } from '@xyflow/react';
import { turnPlacement } from '../route';
import { Port } from './Port';
import type { ReactNode } from 'react';

/**
 * The box a symbol is drawn in, and the thing that makes rotation honest.
 *
 * Rotating used to be a CSS transform on the whole node -- ports included --
 * which moved a port on screen without moving what ReactFlow believed about
 * it. A turned valve's inlet was still recorded as facing left while sitting
 * on the top edge, and the router duly sent its line off sideways.
 *
 * So the ports come out of the rotation and the artwork stays in it: the
 * caller places each port with the side it *now* faces (see `turn`), and
 * everything in here is only the picture. That also lets the box take the
 * turned symbol's shape, which is what stops a rotated tank hanging out of
 * its own bounds.
 *
 * Anything that must stay upright -- a tag, a NO/NC marker -- belongs outside
 * `children`, as a sibling of this component's output, where nothing rotates
 * it in the first place.
 */
export function Frame({ w, h, rotation = 0, children, extra }: {
  w: number;
  h: number;
  rotation?: number;
  /** The artwork. Rotated about the box's centre. */
  children: ReactNode;
  /** Ports, tags and markers. Never rotated. */
  extra?: ReactNode;
}) {
  const quarter = Math.round(((rotation % 360) + 360) % 360 / 90) % 2 === 1;
  const bw = quarter ? h : w;
  const bh = quarter ? w : h;

  return (
    <div style={{ position: 'relative', width: bw, height: bh }}>
      {extra}
      <div
        style={{
          position: 'absolute',
          left: (bw - w) / 2,
          top: (bh - h) / 2,
          width: w,
          height: h,
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center',
          pointerEvents: 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A port placed on a symbol that may have been turned.
 *
 * Takes the side and the distance along it as *drawn* -- the numbers a reader
 * of the artwork would measure -- and puts the handle where those land once
 * the symbol is rotated, facing the way it now faces. Nodes state their
 * geometry once, unturned, and this does the rest.
 */
export function TurnedPort({ id, nodeId, side, along, w, h, rotation = 0 }: {
  id: string;
  nodeId: string;
  side: Position;
  /** Pixels along the edge from the box's top-left. Omitted means centred. */
  along?: number;
  w: number;
  h: number;
  rotation?: number;
}) {
  const quarter = Math.round(((rotation % 360) + 360) % 360 / 90) % 2 === 1;
  const centre = side === Position.Top || side === Position.Bottom ? w / 2 : h / 2;
  const placed = turnPlacement(side, along ?? centre, w, h, rotation);
  const across = placed.side === Position.Top || placed.side === Position.Bottom;
  // Centred ports need no override: ReactFlow already centres them, and on a
  // turned box its 50% is the right 50%.
  const style = along === undefined && !quarter
    ? undefined
    : across ? { left: placed.along } : { top: placed.along };
  return <Port id={id} nodeId={nodeId} position={placed.side} style={style} />;
}

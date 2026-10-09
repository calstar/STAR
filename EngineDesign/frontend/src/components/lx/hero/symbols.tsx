import type { SVGProps } from 'react';
import type { Dir, PlacedSymbol } from './layout';
import { bottleShape, bowtie, ENGINE_PATH, INK, INK_QUIET, PAPER, REG_H, REG_W, tankShape, VALVE_H, VALVE_W } from './shapes';

/**
 * The schematic's symbols: technical line art, flat, 1.5 px, one neutral ink, no glow, no gradient.
 * Each is drawn about its own centre, along its through-axis; state (a shut valve, a tank's
 * level, a lit chamber) is painted over these by the live layer.
 */

const line: SVGProps<SVGPathElement> = { stroke: INK, strokeWidth: 1.5, fill: PAPER, strokeLinejoin: 'round' };

const rot = (d: Dir) => (d === 'right' ? 0 : d === 'down' ? 90 : d === 'left' ? 180 : 270);

export function SymbolShape({ p, ventDir = 'up' }: { p: PlacedSymbol; ventDir?: Dir }) {
  const { s, w, h } = p;
  const vertical = p.axis === 'v';
  const t = `translate(${p.cx} ${p.cy})${vertical ? ' rotate(90)' : ''}`;
  switch (s.kind) {
    case 'tank':
      return <rect transform={`translate(${p.cx} ${p.cy})`} {...tankShape(w, h)} {...(line as SVGProps<SVGRectElement>)} />;
    case 'bottle':
      return (
        <g transform={`translate(${p.cx} ${p.cy})`}>
          <path d={`M-3 ${-h / 2 - 4} h6 v4 h-6 Z`} {...line} />
          <rect {...bottleShape(w, h)} {...(line as SVGProps<SVGRectElement>)} />
        </g>
      );
    case 'dewar':
      return (
        <g transform={`translate(${p.cx} ${p.cy})`}>
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} {...(line as SVGProps<SVGRectElement>)} />
          <rect x={-w / 2 + 3} y={-h / 2 + 3} width={w - 6} height={h - 6} rx={4} fill="none" stroke={INK_QUIET} strokeWidth={1} />
        </g>
      );
    case 'regulator': {
      const dome = s.options.domeLoaded === 'yes';
      return (
        <g transform={t}>
          <path d={`M0 0 V-6`} {...line} fill="none" />
          {dome
            ? <path d={`M-6 -6 A6 6 0 0 1 6 -6 Z`} {...line} />
            : <path d={`M-4 -9 H4 M0 -9 V-6`} {...line} fill="none" />}
          <path d={bowtie(REG_W, REG_H)} {...line} />
        </g>
      );
    }
    case 'solenoid':
      return (
        <g transform={t}>
          <path d="M0 0 V-6" {...line} fill="none" />
          <rect x={-3.5} y={-12} width={7} height={6} rx={1} {...(line as SVGProps<SVGRectElement>)} />
          <path d={bowtie(VALVE_W, VALVE_H)} {...line} />
        </g>
      );
    case 'valve':
      return (
        <g transform={t}>
          <path d="M0 0 V-8 M-4 -8 H4" {...line} fill="none" />
          <path d={bowtie(VALVE_W, VALVE_H)} {...line} />
          <circle r={2.5} {...(line as SVGProps<SVGCircleElement>)} />
        </g>
      );
    case 'check':
      return (
        <g transform={t}>
          <path d={`M-7 -5 L5 0 L-7 5 Z`} {...line} />
          <path d="M6 -6 V6" {...line} fill="none" />
        </g>
      );
    case 'relief':
      return (
        <g transform={t}>
          <path d={bowtie(VALVE_W, VALVE_H)} {...line} />
          <path d="M0 0 V-4 L-3 -6 L3 -8 L-3 -10 L3 -12" {...line} fill="none" />
        </g>
      );
    case 'qd':
      return (
        <g transform={t}>
          <path d="M-7 -5 H-1 V5 H-7 M7 -5 H1 V5 H7" {...line} fill="none" />
        </g>
      );
    case 'manifold':
      return <rect x={p.cx - w / 2} y={p.cy - h / 2} width={w} height={h} rx={1.5} {...(line as SVGProps<SVGRectElement>)} />;
    case 'junction':
      return <circle cx={p.cx} cy={p.cy} r={w / 2} fill={INK} />;
    case 'vent':
      // An open end: a short stub and an arrowhead pointing out to the atmosphere.
      return (
        <g transform={`translate(${p.cx} ${p.cy}) rotate(${rot(ventDir)})`}>
          <path d="M-4 -5 L5 0 L-4 5 Z" {...line} />
        </g>
      );
    case 'engine':
      return <path transform={`translate(${p.cx} ${p.cy})`} d={ENGINE_PATH} {...line} />;
    case 'instrument':
      return null;
  }
}

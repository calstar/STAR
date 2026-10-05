import { Position } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { PIDNodeData } from './types';
import type { LineUnder } from './drop';
import { nearestOnPolyline, pointAt } from './route';
import type { Pt } from './route';
import { unmeasuredEnd } from './unmeasured';

/**
 * The outlets of a 5/2 solenoid manifold, and the dotted lines out of them.
 *
 * What leaves a solenoid manifold's outlet is pilot air to an actuator: it
 * says *what drives what*, not where propellant goes. So its line is not a
 * line in the drawing's sense. It is never an edge -- nothing tees it, colours
 * it with a fluid, asks for its bore, or hands it to feed-twin as a flow path
 * -- and it can end anywhere: on any spot of any symbol, on a line, or on the
 * empty canvas. It is stored on the manifold, one per outlet, the way a
 * probe's leader is stored on the probe (`attachedTo`), and drawn dotted.
 */
export interface Signal {
  /** What it ends on: a symbol's id, a line's id, or nothing for a point on the canvas. */
  to?: string;
  /** On a symbol, where on it, from its top-left; on the canvas, where. */
  at?: Pt;
  /** On a line, how far along it, as a fraction of its drawn length. */
  along?: number;
}

export type Signals = Record<string, Signal>;

const dataOf = (n: Node | undefined) => n?.data as unknown as (PIDNodeData & { signals?: Signals }) | undefined;

/** Is this port a solenoid manifold's outlet: a dotted line's start, never a flow port? */
export function isSignalPort(node: Node | undefined, handle: string | null | undefined): boolean {
  return !!handle && dataOf(node)?.componentType === 'VALVE_BANK' && /^p\d*$/.test(handle);
}

/** Let go right on a solenoid manifold's outlet, which takes no flow line. */
export function landsOnSignalPort(under: { handle?: { nodeId: string; handleId: string } | null }, nodes: Node[]): boolean {
  const h = under.handle;
  return !!h && isSignalPort(nodes.find(n => n.id === h.nodeId), h.handleId);
}

export const signalsOf = (node: Node | undefined): Signals => dataOf(node)?.signals ?? {};

/**
 * Where a dotted line pulled out of `bankId` ends, let go at `at` with
 * `under` beneath the pointer: the symbol there (any of it, ports or not),
 * else the line, else the canvas. Null when let go on its own manifold.
 */
export function signalTo(
  bankId: string, at: Pt, under: { node?: string | null; line?: LineUnder | null }, nodes: Node[],
): Signal | null {
  const n = under.node ? nodes.find(x => x.id === under.node) : undefined;
  if (n?.id === bankId) return null;
  // A section box or a note is scenery drawn over the drawing: what is under
  // it is meant, as when a probe is dropped (`clipAt`).
  if (n && n.type !== 'REGION' && n.type !== 'TEXT') {
    return { to: n.id, at: { x: at.x - n.position.x, y: at.y - n.position.y } };
  }
  if (under.line) {
    const on = nearestOnPolyline(under.line.points, under.line.at);
    if (on) return { to: under.line.id, along: on.t };
  }
  return { at: { x: at.x, y: at.y } };
}

/** `nodes`, with the dotted line out of `port` of `bankId` set to `signal`, or taken away. */
export function setSignal(nodes: Node[], bankId: string, port: string, signal: Signal | null): Node[] {
  return nodes.map(n => {
    if (n.id !== bankId) return n;
    const signals = { ...signalsOf(n) };
    if (signal) signals[port] = signal;
    else delete signals[port];
    const data = { ...n.data } as Record<string, unknown>;
    if (Object.keys(signals).length) data.signals = signals;
    else delete data.signals;
    return { ...n, data };
  });
}

/** One dotted line as drawn: whose and which outlet, the path, and where it lands. */
export interface SignalPath {
  bank: string;
  port: string;
  d: string;
  end: Pt;
  /** Landed on a symbol or a line, so it is marked with a dot; a canvas end is not. */
  lands: boolean;
}

/** How far a dotted line runs straight out of its outlet before it turns. */
const STUB = 10;

/**
 * Every dotted line on the drawing: out of its outlet a short way, then one
 * corner to where it ends. One whose manifold, symbol or line is not shown
 * -- on another page, or gone -- is not drawn.
 */
export function signalPaths(nodes: Node[], routes: ReadonlyMap<string, Pt[]>): SignalPath[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out: SignalPath[] = [];
  for (const bank of nodes) {
    if (bank.hidden || dataOf(bank)?.componentType !== 'VALVE_BANK') continue;
    for (const [port, signal] of Object.entries(signalsOf(bank))) {
      const start = unmeasuredEnd(bank, port);
      if (!start) continue;
      let end: Pt | null = null;
      if (signal.to) {
        const host = byId.get(signal.to);
        if (host) {
          if (host.hidden || !signal.at) continue;
          end = { x: host.position.x + signal.at.x, y: host.position.y + signal.at.y };
        } else {
          const pts = routes.get(signal.to);
          end = pts && pts.length >= 2 ? pointAt(pts, signal.along ?? 0.5)?.point ?? null : null;
        }
      } else if (signal.at) {
        end = signal.at;
      }
      if (!end) continue;
      const dx = start.side === Position.Left ? -1 : start.side === Position.Right ? 1 : 0;
      const dy = start.side === Position.Top ? -1 : start.side === Position.Bottom ? 1 : 0;
      const sx = start.x + dx * STUB, sy = start.y + dy * STUB;
      const corner = dy !== 0 ? { x: end.x, y: sy } : { x: sx, y: end.y };
      out.push({
        bank: bank.id, port,
        d: `M ${start.x} ${start.y} L ${sx} ${sy} L ${corner.x} ${corner.y} L ${end.x} ${end.y}`,
        end, lands: !!signal.to,
      });
    }
  }
  return out;
}

/** The lines dotted lines end on, which have to be followed as they are drawn. */
export function signalLines(nodes: Node[]): string[] {
  const ids = new Set(nodes.map(n => n.id));
  const out = new Set<string>();
  for (const n of nodes) for (const s of Object.values(signalsOf(n))) if (s.to && !ids.has(s.to)) out.add(s.to);
  return [...out];
}

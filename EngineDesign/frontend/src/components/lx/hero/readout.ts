import { partsQ, type Quantity, type Units } from '../units';
import { at } from './contract';
import type { DSymbol } from './drawing';
import type { Reading } from './network';

/**
 * The hover card's rows for a line or a symbol at one sample: stand words, the page's units, and
 * only the rows the run carries (no "—" rows for what was never recorded).
 *
 * Pressures are absolute, as on every other Burn page, except the two a person reads off a gauge:
 * the bottle (its dial) and an instrument (what the DAQ shows).
 */

export interface Row {
  label: string;
  num: string;
  unit: string;
  /** A quieter second value: "of 6.60 kg". */
  note?: string;
}

const row = (label: string, q: Quantity, note?: string): Row | null => {
  const p = partsQ(q);
  return p.num === '—' ? null : { label, num: p.num, unit: p.unit, note };
};

/** "Open", "Shut", "40 % open"; null when unknown. */
export function stateWord(state: number | null): string | null {
  if (state === null || !Number.isFinite(state)) return null;
  if (state >= 0.99) return 'Open';
  if (state <= 0.01) return 'Shut';
  return `${Math.round(state * 100)}\u00a0% open`;
}

const keep = (rows: (Row | null)[]): Row[] => rows.filter((r): r is Row => r !== null);

export function lineRows(r: Reading | undefined, i: number, u: Units): Row[] {
  if (!r) return [];
  return keep([
    row('Pressure', u.p(at(r.p, i))),
    row('Flow', u.mdot(at(r.mdot, i))),
    row('Temperature', u.temp(at(r.T, i))),
    row('Line loss', u.dp(at(r.dp, i))),
    row('To boiling', u.gap(at(r.sat, i))),
  ]);
}

export function symbolRows(s: DSymbol, r: Reading | undefined, i: number, u: Units): Row[] {
  if (!r) return [];
  switch (s.kind) {
    case 'tank':
    case 'dewar': {
      const kg = at(r.liquidKg, i);
      const level = at(r.level, i);
      return keep([
        row('Pressure', u.p(at(r.p, i))),
        row('Liquid', u.m(kg), r.loadedKg ? `of ${u.fmt(u.m(r.loadedKg))}` : undefined),
        row('Level', u.pct(level)),
        row('Ullage gas', u.temp(at(r.T, i))),
        row('Liquid temperature', u.temp(at(r.liquidT, i))),
        row('To boiling', u.gap(at(r.sat, i))),
      ]);
    }
    case 'bottle':
      return keep([
        row('Pressure', u.p(at(r.p, i), 'gauge')),
        row('Gas', u.temp(at(r.T, i))),
        row('Wall', u.temp(at(r.wallT, i))),
        row('Outflow', u.mdot(at(r.mdot, i))),
      ]);
    case 'regulator':
      return keep([
        row('Outlet', u.p(at(r.pOut, i) ?? at(r.p, i))),
        row('Inlet', u.p(at(r.pIn, i))),
        row('Flow', u.mdot(at(r.mdot, i))),
        row('Capacity used', u.pct(at(r.use, i))),
      ]);
    case 'engine':
      return keep([
        row('Chamber', u.p(at(r.p, i))),
        row('Propellant flow', u.mdot(at(r.mdot, i))),
      ]);
    case 'instrument': {
      const v = r.reading ? at(r.reading.values, i) : null;
      if (!r.reading) return [];
      return keep([row('Reads', r.reading.unit === 'psia' ? u.p(v, 'gauge') : u.temp(v))]);
    }
    case 'manifold':
    case 'junction':
      return keep([row('Pressure', u.p(at(r.p, i))), row('Temperature', u.temp(at(r.T, i)))]);
    case 'vent':
      return [];
    default: {
      // Valves.
      const word = stateWord(at(r.state, i));
      return keep([
        word ? { label: 'State', num: word, unit: '' } : null,
        row('Upstream', u.p(at(r.pIn, i))),
        row('Downstream', u.p(at(r.pOut, i))),
        row('Drop', u.dp(at(r.dp, i))),
        row('Flow', u.mdot(at(r.mdot, i))),
      ]);
    }
  }
}

/** The figure printed under a vessel's name on the schematic: its pressure (the chamber's for the engine). */
export function vesselFigure(s: DSymbol, r: Reading | undefined, i: number, u: Units): { num: string; unit: string } | null {
  if (!r) return null;
  if (s.kind === 'tank' || s.kind === 'dewar' || s.kind === 'bottle' || s.kind === 'engine') {
    const p = partsQ(u.p(at(r.p, i), s.kind === 'bottle' ? 'gauge' : 'abs'));
    return p.num === '—' ? null : p;
  }
  if (s.kind === 'regulator' && r.use) {
    const p = partsQ(u.pct(at(r.use, i)));
    return p.num === '—' ? null : p;
  }
  return null;
}

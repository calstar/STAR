/**
 * "Opens in": the states whose column opens a valve connector's name -- its
 * actuator in the state table -- the same in the Symbols panel and the DAQ
 * box. Green, as open is green in the table; Idle struck through, since the
 * twin holds Idle shut whatever the table says.
 */

import { Link } from 'react-router-dom';
import type { MachineDef } from '../api';
import { opensIn, rowNamed } from '../lib/hookupDraft';

/** The State machine tab, open on one actuator's line. */
export const actuatorLink = (name: string) => `/statemachine?actuator=${encodeURIComponent(name)}`;

export function OpensIn({ machine, name }: { machine: MachineDef; name: string }) {
  const actuator = rowNamed(machine, name);
  const states = actuator ? opensIn(machine, actuator) : [];
  return (
    <div
      className="flex items-baseline gap-2 text-[11px] text-gray-500"
      title="The states whose column opens this name. Change them on the State machine tab."
    >
      <span className="w-[4.5rem] shrink-0">Opens in</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-1">
        {states.map((s) =>
          s.toLowerCase() === 'idle' ? (
            <span
              key={s}
              className="px-1 font-mono text-[10.5px] text-gray-500 line-through"
              title="The table opens it in Idle; the twin holds Idle shut."
            >
              {s}
            </span>
          ) : (
            <span key={s} className="rounded bg-[#0b140e] px-1 font-mono text-[10.5px] text-[var(--color-success)]">
              {s}
            </span>
          ),
        )}
        {states.length === 0 &&
          (actuator ? (
            <span>none</span>
          ) : (
            <span
              className="text-amber-300/80"
              title="No actuator in the state table goes by this name, so no state moves it. Name it after one, or add it on the State machine tab."
            >
              not in the state table
            </span>
          ))}
      </span>
      <Link to={actuatorLink(actuator ?? name)} className="shrink-0 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)]">
        State machine →
      </Link>
    </div>
  );
}

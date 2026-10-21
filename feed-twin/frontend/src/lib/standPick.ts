/**
 * Which stand a browser opens on, and what switching away from one costs.
 * Pure, for stand.tsx; tested in standPick.test.ts.
 */

import type { Artifact, Burns, SessionState } from '../api';

/** What a browser opens on, from what the library holds.
 *
 *  A link may name it (`?diagram=&engine=`, by id or by name: the runbook's
 *  links); else this browser's last stand that opened, if the library still
 *  has it; else the library's featured stand (the bundled sample); else the
 *  newest drawing named a stand, and the newest engine. Never simply the
 *  newest artifact: an import used to become every new viewer's stand. */
export function defaultPicks(
  list: readonly Artifact[],
  remembered: { diagram?: string | null; engine?: string | null },
  asked: { diagram?: string | null; engine?: string | null } = {},
): { diagram: string; engine: string } {
  const find = (kind: 'diagram' | 'engine', want?: string | null) => {
    if (!want) return '';
    const of = list.filter((a) => a.kind === kind);
    return (of.find((a) => a.id === want) ?? of.find((a) => a.name.toLowerCase() === want.toLowerCase()))?.id ?? '';
  };
  const diagrams = list.filter((a) => a.kind === 'diagram');
  const engines = list.filter((a) => a.kind === 'engine');
  const featured = (of: Artifact[]) => of.find((a) => a.featured)?.id ?? '';
  const named = diagrams.find((a) => /stand/i.test(a.name)) ?? diagrams[0];
  return {
    diagram: find('diagram', asked.diagram) || find('diagram', remembered.diagram) || featured(diagrams) || named?.id || '',
    engine: find('engine', asked.engine) || find('engine', remembered.engine) || featured(engines) || engines[0]?.id || '',
  };
}

/** What switching away from this stand would throw away, or '' when it is
 *  still a cold, empty stand in Idle that nothing is lost by replacing. */
export function pastIdle(live: SessionState | null, burns: Burns | null): string {
  if (!live) return '';
  const loaded = live.tanks.filter((t) => t.liquid_mass_kg > 0.05).map((t) => t.label);
  const fired = (burns?.burns.length ?? 0) > 0;
  if (live.state === 'Idle' && loaded.length === 0 && !fired) return '';
  const parts = [
    live.state !== 'Idle' ? `in ${live.state}` : '',
    loaded.length ? `${loaded.join(' and ')} loaded` : '',
    fired ? `${burns?.burns.length} burn${burns?.burns.length === 1 ? '' : 's'} on screen` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

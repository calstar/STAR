/**
 * Which stand a browser opens on, and what switching away from one costs.
 * Pure, for stand.tsx; tested in standPick.test.ts.
 */

import type { Artifact, Burns, SessionState } from '../api';

/** What this browser remembers as its engine when the operator took the
 *  engine off: the featured one used to come back on the next reload. */
export const NO_ENGINE = '(no engine)';

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
    engine:
      find('engine', asked.engine) ||
      (remembered.engine === NO_ENGINE
        ? ''
        : find('engine', remembered.engine) || featured(engines) || engines[0]?.id || ''),
  };
}

/** A change held for the operator's yes because the stand on screen is past
 *  Idle and the change throws it away (stand.tsx `PendingPick`). */
export interface Pending {
  /** A drawing or an engine put on the console (an engine id '' takes it
   *  off), or a stand document opened, imported or saved. */
  kind: 'diagram' | 'engine' | 'stand';
  id: string;
  /** The drawing or engine by name; for a stand, the question itself. */
  name: string;
  /** What switching would throw away (`pastIdle`). */
  losing: string;
  /** The yes button, for a stand. */
  yes?: string;
}

/** The question the bar asks, why, and its yes. */
export function pendingWords(p: Pending): { ask: string; why: string; yes: string } {
  const why = `The stand is ${p.losing}; this starts a fresh, empty stand.`;
  if (p.kind === 'stand') return { ask: p.name, why, yes: p.yes ?? 'Open' };
  if (p.kind === 'engine' && p.id === '') {
    const which = p.name ? `the engine ${p.name}` : 'the engine';
    return { ask: `Take ${which} off the console? Fire will light nothing.`, why, yes: 'Take it off' };
  }
  return { ask: `Put ${p.kind === 'diagram' ? 'the drawing' : 'the engine'} ${p.name} on the console?`, why, yes: 'Switch' };
}

/** Why a stand did not open, and whether its drawing is to blame. Only a
 *  build the server refused (422) is the drawing's; a full server (503), a
 *  dropped connection or anything else is worth trying again. Every failure
 *  used to read "The drawing needs fixing in Hotbench P&ID", with no retry. */
export function whyNotOpened(e: unknown): { reason: string; drawing: boolean } {
  const reason = e instanceof Error ? e.message : String(e);
  const status = typeof e === 'object' && e !== null && 'status' in e ? Number((e as { status: unknown }).status) : NaN;
  return { reason, drawing: status === 422 };
}

/** Whether the library list on screen is missing a drawing or engine the
 *  stand runs on. An imported stand brings both into the library on the
 *  server; read once at page load, the list never had them, and the Engine
 *  tab said "No engine on this stand" over a stand burning one. */
export function listIsBehind(list: readonly Artifact[], ids: readonly string[]): boolean {
  return ids.some((id) => id !== '' && !list.some((a) => a.id === id));
}

/** Knob positions [psig] by knob id, and the drawing they belong to. */
export interface KnobsOn {
  diagram: string;
  knobs: Record<string, number>;
}

/** Where the knobs go on a stand that opens fresh on `diagram`.
 *
 *  A stand document just opened puts its saved knobs back. Otherwise --
 *  Reset, a switch of gas, a saved hookup, a server that forgot the session --
 *  the regulators stay where the session it replaces left them, as the trip
 *  screen promises: Reset used to apply the stand's saved knobs every time,
 *  and a dome turned to 600 came back at 535. A stand closed on this drawing
 *  hands its knobs on, once, when nothing nearer says where they are. */
export function openingKnobs(o: {
  diagram: string;
  /** The stand document's knobs, when it is open on this drawing. */
  saved: Record<string, number> | null;
  /** Where the session being replaced left them. */
  left: KnobsOn | null;
  /** The stand document was opened just now. */
  standOpened: boolean;
  /** What a closed stand left this cockpit. */
  closed: KnobsOn | null;
}): Record<string, number> {
  if (!o.standOpened && o.left?.diagram === o.diagram && Object.keys(o.left.knobs).length) return o.left.knobs;
  if (o.saved) return o.saved;
  return o.closed?.diagram === o.diagram ? o.closed.knobs : {};
}

/** A setting that changes the network -- ignoring the drawn GSE, another
 *  pressurant -- as the question to ask before it reopens the stand, or ''
 *  for one the running stand takes as it is. */
export function networkChange(
  patch: { ignore_gse?: boolean; pressurant?: string },
  setup: { ignore_gse?: boolean; pressurant?: string },
): string {
  if ('ignore_gse' in patch && Boolean(patch.ignore_gse) !== Boolean(setup.ignore_gse)) {
    return patch.ignore_gse ? 'Ignore the drawn GSE and run the rocket alone?' : 'Simulate the drawn GSE again?';
  }
  if ('pressurant' in patch && (patch.pressurant ?? '') !== (setup.pressurant ?? '')) {
    const gas = patch.pressurant === 'helium' ? 'helium' : patch.pressurant === 'nitrogen' ? 'GN2' : "the drawing's gas";
    return `Switch the pressurant to ${gas}?`;
  }
  return '';
}

/** When a change of the network may reopen the stand: at once on a cold
 *  stand, on a yes past Idle (as a drawing switch), and never mid-burn --
 *  the burn would never reach its run record. */
export function networkSwitch(
  live: SessionState | null,
  burns: Burns | null,
  ground: ReadonlySet<string> = new Set(),
): 'now' | 'ask' | 'refuse' {
  if (live && /^fire$/i.test(live.state)) return 'refuse';
  return pastIdle(live, burns, ground) ? 'ask' : 'now';
}

/** What switching away from this stand would throw away, or '' when it is
 *  still a cold, empty stand in Idle that nothing is lost by replacing. The
 *  cart's own tanks (`ground`: a dewar, a transfer tank) arrive loaded and
 *  every fresh stand has them so: they are not what switching loses. */
export function pastIdle(live: SessionState | null, burns: Burns | null, ground: ReadonlySet<string> = new Set()): string {
  if (!live) return '';
  const loaded = live.tanks.filter((t) => !ground.has(t.id) && t.liquid_mass_kg > 0.05).map((t) => t.label);
  const fired = (burns?.burns.length ?? 0) > 0;
  if (live.state === 'Idle' && loaded.length === 0 && !fired) return '';
  const parts = [
    live.state !== 'Idle' ? `in ${live.state}` : '',
    loaded.length ? `${loaded.join(' and ')} loaded` : '',
    fired ? `${burns?.burns.length} burn${burns?.burns.length === 1 ? '' : 's'} on screen` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

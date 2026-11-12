/**
 * The wire form of a per-run valve plan.
 *
 * A plan says what ONE entry into a state does with individual valves: hold one shut, or open it
 * on its own delay instead of the delays CSV's. It rides on the ordinary TRANSITION command as
 * `:VALVES=<role>=<ms|shut>,...` and is parsed by ValvePlan.hpp at the other end.
 *
 * Kept in its own module, away from the command switch, because the grammar is the part worth
 * testing: the list is comma-and-equals separated, so a role name carrying either separator cannot
 * be expressed and must be REFUSED rather than sent as something else. The sequencer is still the
 * authority on everything that matters physically — which states accept a plan (never the burn),
 * which valves it may name, and whether a delay fits inside the window. This function only decides
 * whether the frame can be written down.
 */

/** 60 s, matching kMaxValveDelayMs in ValvePlan.hpp. The wire ceiling, not the real limit: the
 *  sequencer refuses any delay reaching past the end of the hold, which is far smaller. */
export const MAX_VALVE_DELAY_MS = 60000;

export interface ValvePlanEntry {
  shut?: boolean;
  delayMs?: number;
}

/**
 * Build the `:VALVES=...` suffix for a transition.
 *
 * @returns `{ suffix }` on success — an empty string when the plan carries no instruction, since
 *          an empty object is "no plan" rather than "a plan of nothing", and sending `:VALVES=`
 *          would be a parse error at the sequencer for no reason. `{ error }` otherwise, with a
 *          sentence for the operator.
 */
export function valvePlanSuffix(plan: unknown): { suffix: string } | { error: string } {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan))
    return { error: 'expected an object keyed by valve name' };

  const fields: string[] = [];
  for (const [role, raw] of Object.entries(plan as Record<string, unknown>)) {
    if (!role.trim() || /[,=:\n\r]/.test(role))
      return {
        error: `valve name "${role}" cannot be sent (it must not be empty or contain , = : or a newline)`,
      };
    if (!raw || typeof raw !== 'object')
      return { error: `valve "${role}" has no plan` };
    const entry = raw as ValvePlanEntry;
    if (entry.shut) {
      fields.push(`${role}=shut`);
      continue;
    }
    // An absent delay on a valve that is not held shut means "open it with the first stage" — the
    // override that cancels a configured stagger. It is explicit on the wire, never omitted: the
    // sequencer reads an absent role as "use the CSV", which is the opposite instruction.
    const d = entry.delayMs ?? 0;
    if (!Number.isInteger(d) || d < 0 || d > MAX_VALVE_DELAY_MS)
      return { error: `valve "${role}" has an invalid delay: ${entry.delayMs}` };
    fields.push(`${role}=${d}`);
  }

  return { suffix: fields.length > 0 ? `:VALVES=${fields.join(',')}` : '' };
}

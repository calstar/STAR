// The Outreach Correspondence project on the task board already holds the
// sponsor list as task titles: "Correspondence - Garmin (inReach satellite
// communicators for desert recovery)", "Swage Sponsorship", "Get PT sponsorship".
// This reads an org name and the ask out of a title so each task can become a
// deal linked back to it. Pure.

export type TaskOrg = { orgName: string; ask: string | null; renewal: boolean };

export function orgFromTaskTitle(title: string): TaskOrg | null {
  const t = title.trim();
  const m = t.match(/^correspondence\s*[-–—:]\s*(.+)$/i);
  if (m) {
    const rest = m[1].trim();
    const paren = rest.match(/^(.*?)\s*\((.*)\)\s*$/);
    const name = (paren ? paren[1] : rest).trim();
    const note = paren ? paren[2].trim() : null;
    if (!name) return null;
    const renewal = !!note && /\brenewal\b/i.test(note);
    // "(renewal)" alone says nothing about the ask; "(renewal - valves)" does.
    const ask = note ? note.replace(/^renewal\s*[-–—:]?\s*/i, "").trim() || null : null;
    return { orgName: name, ask, renewal };
  }
  // "Swagelok - request sponsorship/discount on 3/8\" fittings": org, then the ask.
  const dash = t.match(/^([^-–—:]{2,40}?)\s+[-–—:]\s+(.*\bsponsor.*)$/i);
  // ...but not a to-do that starts with a verb ("Source COPV tanks - ... request sponsorship").
  const todo = /^(source|find|identify|get|stretch|contact|email|reach|ask|request|look|research|buy)\b/i;
  if (dash && dash[1].split(/\s+/).length <= 4 && !todo.test(dash[1])) return { orgName: dash[1].trim(), ask: dash[2].trim(), renewal: false };
  // "Swage Sponsorship", "Get PT sponsorship": the words before "sponsorship".
  const s = t.match(/^(?:get\s+)?(.+?)\s+sponsorship\b/i);
  if (s && s[1].split(/\s+/).length <= 4) return { orgName: s[1].trim(), ask: null, renewal: false };
  return null;
}

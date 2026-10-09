/**
 * The assembly's warnings, sorted into what a person should do something
 * about and what is only the twin saying how it read the drawing.
 *
 * The backend says each one in a sentence, one per symbol: seven relief
 * valves with no set pressure were seven paragraphs. Grouped here by kind,
 * one line per kind naming the symbols, with the sentence on hover -- and the
 * tab's count is only the first kind, so "Checks 34" stops meaning "34
 * things wrong" when most were "this is how I joined your pages".
 *
 * Matched on the backend's own wording (feedtwin.pid.network and
 * backend.assembly); a sentence nothing matches is shown whole under "Worth a
 * look", so a new warning is never dropped.
 */

export type CheckKind = 'fix' | 'assumed' | 'read';

export interface CheckGroup {
  kind: CheckKind;
  title: string;
  /** The symbols (or pairs) it names. Empty: the title is the whole note. */
  items: string[];
  /** One of the backend's sentences, for the hover. */
  detail: string;
}

interface Rule {
  kind: CheckKind;
  match: RegExp;
  /** The group's title, from the match (so "no diameter: 152 mm" and "no
   *  volume: 17.5 L" are two groups). */
  title: (m: RegExpExecArray) => string;
  /** What the sentence names; several for a list. */
  items: (m: RegExpExecArray) => string[];
}

const RULES: Rule[] = [
  {
    kind: 'fix',
    match: /simplified model/,
    title: () => "Feedtwin's simplified engine is firing, not EngineDesign's — build the engine card in Library",
    items: () => [],
  },
  {
    kind: 'fix',
    match: /^(.+?) is a relief valve with no set_pressure/,
    title: () => 'Relief valves with no set pressure — read as shut, they never lift',
    items: (m) => [m[1]],
  },
  {
    kind: 'fix',
    match: /^(.+?) segment (\S+): itemised but states no bore/,
    title: () => 'Line segments with no bore — they add no loss',
    items: (m) => [`${m[1].replace(/^[^:]*:/, '')} ${m[2]}`],
  },
  {
    kind: 'fix',
    match: /has no single free side to couple: (.+?) left unmated/,
    title: () => 'Paired disconnects that could not be mated — the pages stay apart there',
    items: (m) => [m[1].replace(' and ', ' ↔ ')],
  },
  {
    kind: 'fix',
    match: /^(.+?) is drawn as a TANK but holds (\w+) above its critical temperature/,
    title: () => 'Gas drawn as a TANK — read as a pressurant bottle; draw it as a KBOTTLE',
    items: (m) => [m[1]],
  },
  {
    kind: 'assumed',
    match: /^(.+?) has no (diameter|volume) on the drawing; its static head assumes (?:a )?(.+?)(?: bore)?\.$/,
    title: (m) => `No ${m[2]} on the drawing — ${m[3]} assumed`,
    items: (m) => [m[1]],
  },
  {
    kind: 'assumed',
    match: /^No vent valve is drawn on (.+?), so (.+?) on the tank top/,
    title: () => 'No vent drawn — the tank-top disconnect is taken as where the GSE vent couples',
    items: (m) => [`${m[1]} → ${m[2]}`],
  },
  {
    kind: 'read',
    match: /^(.+?) and (.+?) are paired, so they are read as one mated coupling/,
    title: () => 'Disconnects mated across pages',
    items: (m) => [`${m[1]} ↔ ${m[2]}`],
  },
  {
    kind: 'read',
    match: /^(.+?): every line was drawn (?:out of|into) it/,
    title: () => 'Valves whose direction was taken from the ports the lines were drawn on',
    items: (m) => [m[1]],
  },
  {
    kind: 'read',
    match: /^(.+?): the run is itemised into \d+ segment/,
    title: () => 'Lines itemised into segments — their line-level size is not used',
    items: (m) => [m[1].replace(/^[^:]*:/, '')],
  },
  {
    kind: 'read',
    match: /^\d+ hand valve\(s\) rest shut until opened by hand: (.+?)\.?$/,
    title: () => 'Hand valves rest shut until opened on the P&ID',
    items: (m) => m[1].split(', '),
  },
  {
    kind: 'read',
    match: /^\d+ valve\(s\) have one side open and are read as venting to atmosphere: (.+?)\. /,
    title: () => 'Valves open on one side — read as vents to atmosphere',
    items: (m) => m[1].split(', '),
  },
  {
    kind: 'read',
    match: /^(.+?) loads the dome of (.+?);/,
    title: () => 'Dome loaders',
    items: (m) => [`${m[1]} → ${m[2]}`],
  },
];

/** The warnings, grouped by kind, in the order the rules list them. */
export function groupChecks(warnings: readonly string[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>();
  const other: CheckGroup[] = [];
  for (const w of warnings) {
    let placed = false;
    for (const rule of RULES) {
      const m = rule.match.exec(w);
      if (!m) continue;
      const title = rule.title(m);
      const group = groups.get(title) ?? { kind: rule.kind, title, items: [], detail: w };
      group.items.push(...rule.items(m));
      groups.set(title, group);
      placed = true;
      break;
    }
    if (!placed) other.push({ kind: 'fix', title: w, items: [], detail: w });
  }
  const order: CheckKind[] = ['fix', 'assumed', 'read'];
  return [...groups.values(), ...other].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** What the tab's badge counts: the things worth fixing, one per symbol. */
export function checksToFix(warnings: readonly string[]): number {
  return groupChecks(warnings)
    .filter((g) => g.kind === 'fix')
    .reduce((n, g) => n + Math.max(g.items.length, 1), 0);
}

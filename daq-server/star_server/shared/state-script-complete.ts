/**
 * Completions for the dynamic-state script editor.
 *
 * Pure: source text and a caret offset in, a list out. No DOM, no React — the part that decides
 * WHAT to suggest is the part that can be wrong in interesting ways, so it is testable on its own
 * rather than trapped inside a component that needs a browser to exercise.
 *
 * The rule it exists to enforce: names are suggested by SLOT, never by spelling. Inside
 * `transition_to(` only states appear, even though the same word may also be a valve — which on
 * the shipped `server` profile it often is.
 */
import { caretContext, BUILTIN_ARG, type CaretContext } from './state-script-tokens.js';
import type { ScriptNameTables } from './state-script-names.js';

export interface Completion {
  /** Inserted verbatim. May carry punctuation the list does not show, e.g. a closing paren. */
  text: string;
  /** What the popup shows. Defaults to `text`. Kept separate so the list reads as names —
   *  `FUEL_VENT`, not `FUEL_VENT)` — while the insert still closes the call. */
  label?: string;
  /** Shown beside it — what this is, or where it leads. */
  detail: string;
  kind: 'valve' | 'sensor' | 'state' | 'command' | 'keyword' | 'variable';
  /** Put the caret here, relative to the start of `text`. Used to land inside a call's parens.
   *  Undefined means "after the inserted text". */
  caretOffset?: number;
  /** Reopen the popup straight after inserting — the second half of `open_valve(` → pick a valve. */
  reopen?: boolean;
}

export interface CompletionResult {
  items: Completion[];
  /** Replace exactly this range with the chosen text. */
  from: number;
  to: number;
  context: CaretContext;
}

/** Statement-position built-ins, in the order an operator is likely to want them. */
const COMMANDS: Completion[] = [
  { text: 'open_valve(', detail: 'open a valve and keep it open', kind: 'command', reopen: true },
  { text: 'close_valve(', detail: 'close a valve and keep it closed', kind: 'command', reopen: true },
  { text: 'delay(', detail: 'wait, in seconds', kind: 'command' },
  { text: 'transition_to(', detail: 'leave for another state — ends the script', kind: 'command', reopen: true },
  { text: 'if ', detail: 'condition', kind: 'keyword' },
  { text: 'elif ', detail: 'further condition', kind: 'keyword' },
  { text: 'else:', detail: 'otherwise', kind: 'keyword' },
  { text: 'while ', detail: 'repeat — the body must contain a delay()', kind: 'keyword' },
];

/** Value-position built-ins. */
const VALUES: Completion[] = [
  { text: 'pressure(', detail: 'live calibrated PSI', kind: 'command', reopen: true },
  { text: 'elapsed()', detail: 'seconds since entering this state', kind: 'command' },
  { text: 'not ', detail: 'negate', kind: 'keyword' },
];

/**
 * Variables assigned anywhere in the script.
 *
 * Flow-insensitive, matching the parser: a variable first assigned inside an `if` counts as
 * assigned afterwards. Being stricter here would hide a name the script can legitimately use.
 */
function assignedVariables(src: string): string[] {
  const out = new Set<string>();
  for (const raw of src.split('\n')) {
    const line = raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * Rank matches: exact prefix first, then a match anywhere, each alphabetically.
 *
 * Case-insensitive on input but not on output — slugs are uppercase, and an operator typing `fu`
 * should still be offered `FUEL_VENT`.
 */
function filter<T extends { text: string; label?: string }>(items: T[], prefix: string): T[] {
  if (!prefix) return items;
  const p = prefix.toUpperCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    // Match what the operator sees, not what gets inserted — the auto-closing paren on `text` is
    // punctuation they never typed and must not have to match against.
    const t = (it.label ?? it.text).toUpperCase();
    if (t.startsWith(p)) starts.push(it);
    else if (t.includes(p)) contains.push(it);
  }
  return [...starts, ...contains];
}

export function completionsAt(
  src: string,
  caret: number,
  tables: ScriptNameTables,
): CompletionResult | null {
  const ctx = caretContext(src, caret);
  if (!ctx) return null; // inside a comment

  /**
   * Close the call for them.
   *
   * open_valve, close_valve, pressure and transition_to all take exactly ONE argument, so once the
   * name is chosen the call is finished and there is nothing else the paren could be waiting for.
   * Typing it by hand is pure ceremony, and an unclosed paren is a parse error the operator then
   * has to go back and fix.
   *
   * Unless one is already there — completing into `open_valve(MA|)` must not leave `MAIN_VALVE))`.
   */
  const closer = /^\s*\)/.test(src.slice(ctx.to)) ? '' : ')';
  const name = (t: string, detail: string, kind: 'valve' | 'sensor' | 'state'): Completion =>
    ({ text: t + closer, label: t, detail, kind });

  let pool: Completion[];
  switch (ctx.kind) {
    case 'valve':
      pool = [...tables.actuators].sort().map((t) => name(t, 'valve', 'valve'));
      break;
    case 'sensor':
      pool = [...tables.sensors].sort().map((t) => name(t, 'sensor', 'sensor'));
      break;
    case 'state':
      // Only states this one may actually reach. Offering the rest would be offering a config the
      // sequencer refuses at load — the editor should not be able to author that.
      pool = [...tables.allowedTransitions].sort().map((t) => name(t, 'state', 'state'));
      break;
    case 'command':
      pool = COMMANDS;
      break;
    case 'expr':
      pool = [
        ...assignedVariables(src).map((t) => ({ text: t, detail: 'variable', kind: 'variable' as const })),
        ...VALUES,
      ];
      break;
  }

  const items = filter(pool, ctx.prefix);
  if (items.length === 0) return null;
  return { items, from: ctx.from, to: ctx.to, context: ctx };
}

/** Everything a caller needs to apply a choice: the new source, and where the caret goes. */
export function applyCompletion(
  src: string,
  result: CompletionResult,
  item: Completion,
): { source: string; caret: number } {
  const source = src.slice(0, result.from) + item.text + src.slice(result.to);
  const caret = result.from + (item.caretOffset ?? item.text.length);
  return { source, caret };
}

export { BUILTIN_ARG };

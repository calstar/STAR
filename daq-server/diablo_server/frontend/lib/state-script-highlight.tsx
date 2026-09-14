/**
 * Turning a script into coloured spans, for the highlight mirror behind the editor's textarea.
 *
 * Lives here rather than inline in the config page so the test exercises THIS function instead of
 * a copy of it — a duplicated mirror in a test file passes happily while the real one drifts.
 *
 * The property that matters is that the rendered text is character-for-character identical to the
 * source. The mirror sits underneath a transparent textarea; a single missing space slides every
 * colour after it off its word, and slides further the longer the line, so it reads as an
 * intermittent glitch rather than as a bug.
 */
import type { ReactNode } from 'react';
import { tokenize } from './state-script-tokens';
import type { ScriptNameTables } from './state-script-names';

/** Colour per token kind. Shared with the legend and the completion popup so all three agree. */
export const TOKEN_CLASS: Record<string, string> = {
  command: 'text-purple-300',
  valve: 'text-amber-300',
  sensor: 'text-cyan-300',
  state: 'text-emerald-300',
  keyword: 'text-blue-300',
  number: 'text-orange-300',
  comment: 'text-gray-500',
  variable: 'text-gray-100',
  op: 'text-gray-400',
  unknown: 'text-red-400',
};

/**
 * Every text metric the mirror and the textarea must agree on, as one class string applied to
 * both. `whitespace-pre` (no wrapping) removes the hardest alignment case and is how a code editor
 * behaves anyway; long lines scroll horizontally, with both elements synced.
 */
export const EDITOR_TEXT = 'font-mono text-sm p-2 leading-6 whitespace-pre overflow-auto';
/** Matches EDITOR_TEXT's leading-6 — used to place the completion popup on the right line. */
export const LINE_HEIGHT_PX = 24;
/** Matches EDITOR_TEXT's p-2. */
export const EDITOR_PAD_PX = 8;

export function highlightSpans(src: string, tables: ScriptNameTables): ReactNode[] {
  const toks = tokenize(src, tables);
  const out: ReactNode[] = [];
  let at = 0;

  toks.forEach((t, i) => {
    // Whitespace between tokens goes out verbatim. The tokenizer skips it; the mirror cannot.
    if (t.start > at) out.push(src.slice(at, t.start));
    const bad = t.known === false;
    out.push(
      <span
        key={i}
        data-kind={t.kind}
        data-known={t.known === undefined ? undefined : String(t.known)}
        className={`${TOKEN_CLASS[t.kind] ?? ''}${bad ? ' underline decoration-red-500 decoration-wavy' : ''}`}
      >
        {t.text}
      </span>,
    );
    at = t.end;
  });

  if (at < src.length) out.push(src.slice(at));
  // A trailing newline would leave the mirror one line shorter than the textarea, so the last line
  // scrolls out of step. A zero-width space holds that line open.
  out.push('​');
  return out;
}

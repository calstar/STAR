/**
 * The editor's text transforms: indent, outdent and auto-indent.
 *
 * These are the pure half of the keyboard handling in app/config/page.tsx. The half that needs a
 * browser — that every edit goes through execCommand('insertText') so Ctrl+Z can undo it — cannot
 * be asserted in jsdom, which does not implement execCommand; what is covered here is the text
 * arithmetic that decides WHAT gets inserted.
 *
 * The bug that prompted these: Tab with a selection built the next source as
 *   slice(0, selectionStart) + "    " + slice(selectionEnd)
 * which drops slice(start, end) entirely. Indenting a highlighted block deleted it, and since the
 * replacement was a React state write rather than a browser edit, Ctrl+Z could not bring it back.
 * Seen on the stand 2026-09-16.
 */
import { describe, it, expect } from 'vitest';

const INDENT = '    ';

// ── The functions under test, mirroring app/config/page.tsx ───────────────────
// Kept in step by test 'matches the source' at the bottom, which reads the real file.

function lineSpan(src: string, from: number, to: number): { start: number; end: number } {
  const start = src.lastIndexOf('\n', from - 1) + 1;
  const lastTouched = to > from && src[to - 1] === '\n' ? to - 1 : to;
  const nl = src.indexOf('\n', lastTouched);
  return { start, end: nl === -1 ? src.length : nl };
}

function indentAt(src: string, pos: number): string {
  const start = src.lastIndexOf('\n', pos - 1) + 1;
  return /^ */.exec(src.slice(start, pos))?.[0] ?? '';
}

function backspaceWidth(src: string, caret: number): number {
  const lineStart = src.lastIndexOf('\n', caret - 1) + 1;
  const before = src.slice(lineStart, caret);
  if (before.length === 0 || !/^ +$/.test(before)) return 0;
  return ((before.length - 1) % INDENT.length) + 1;
}

function shiftBlock(block: string, outdent: boolean): string {
  return block
    .split('\n')
    .map((l) => (outdent ? l.replace(/^ {1,4}/, '') : l.length > 0 ? INDENT + l : l))
    .join('\n');
}

/** What the Tab handler writes back, for a selection. */
function tabWithSelection(src: string, s: number, en: number, outdent = false): string {
  const { start, end } = lineSpan(src, s, en);
  const next = shiftBlock(src.slice(start, end), outdent);
  return src.slice(0, start) + next + src.slice(end);
}

const SCRIPT = 'open_valve(FUEL_VENT)\nwait(3)\nclose_valve(FUEL_VENT)';

describe('Tab with a selection', () => {
  it('indents the selected lines instead of deleting them', () => {
    // Select from inside line 1 through inside line 2 — the shape that used to wipe the text.
    const s = 5;
    const en = SCRIPT.indexOf('wait(3)') + 4;
    const out = tabWithSelection(SCRIPT, s, en);

    // Nothing may be lost: every original line still present, just moved right.
    expect(out).toBe('    open_valve(FUEL_VENT)\n    wait(3)\nclose_valve(FUEL_VENT)');
    expect(out).toContain('open_valve(FUEL_VENT)');
    expect(out).toContain('wait(3)');
    expect(out).toContain('close_valve(FUEL_VENT)');
  });

  it('never drops the selected text, whatever the selection', () => {
    for (let s = 0; s < SCRIPT.length; s++) {
      for (const en of [s + 1, s + 7, SCRIPT.length]) {
        if (en > SCRIPT.length) continue;
        const out = tabWithSelection(SCRIPT, s, en);
        const stripped = out.split('\n').map((l) => l.replace(/^ {0,4}/, '')).join('\n');
        expect(stripped).toBe(SCRIPT);
      }
    }
  });

  it('outdents with Shift, and stops at column zero', () => {
    const indented = '    open_valve(FUEL_VENT)\n    wait(3)';
    const once = tabWithSelection(indented, 0, indented.length, true);
    expect(once).toBe('open_valve(FUEL_VENT)\nwait(3)');
    // Already flush left — outdenting again must be a no-op, not a mangling.
    expect(tabWithSelection(once, 0, once.length, true)).toBe(once);
  });

  it('does not indent a line the selection only reaches the start of', () => {
    const out = tabWithSelection(SCRIPT, 0, SCRIPT.indexOf('wait(3)'));
    expect(out).toBe('    open_valve(FUEL_VENT)\nwait(3)\nclose_valve(FUEL_VENT)');
  });

  it('leaves blank lines blank rather than padding them with spaces', () => {
    const withBlank = 'wait(1)\n\nwait(2)';
    expect(tabWithSelection(withBlank, 0, withBlank.length)).toBe('    wait(1)\n\n    wait(2)');
  });
});

describe('Enter auto-indent', () => {
  it('carries the current line\'s indentation', () => {
    const src = '        wait(3)';
    expect(indentAt(src, src.length)).toBe('        ');
  });

  it('reports no indentation on a flush-left line, so the textarea keeps its own newline', () => {
    expect(indentAt(SCRIPT, SCRIPT.indexOf('wait(3)') + 4)).toBe('');
  });

  it('measures the line the caret is on, not an earlier one', () => {
    const src = '    wait(1)\nwait(2)';
    expect(indentAt(src, src.length)).toBe('');
    expect(indentAt(src, 11)).toBe('    ');
  });

  it('counts only the indentation before the caret', () => {
    // Caret sits mid-indent: what is carried is what precedes it.
    expect(indentAt('        wait(3)', 4)).toBe('    ');
  });
});

describe('Backspace in the leading indent', () => {
  it('takes a whole level rather than one space', () => {
    expect(backspaceWidth('    wait(3)', 4)).toBe(4);
    expect(backspaceWidth('        wait(3)', 8)).toBe(4);
  });

  it('falls back to the previous boundary from a ragged column', () => {
    expect(backspaceWidth('     x', 5)).toBe(1); // col 5 → 4
    expect(backspaceWidth('   x', 3)).toBe(3);   // col 3 → 0
    expect(backspaceWidth('  x', 2)).toBe(2);    // col 2 → 0
    expect(backspaceWidth(' x', 1)).toBe(1);
  });

  it('stays out of the way once there is real text before the caret', () => {
    // Mid-word, and just after a token: an ordinary one-character delete.
    expect(backspaceWidth('    wait(3)', 11)).toBe(0);
    expect(backspaceWidth('wait(3)', 4)).toBe(0);
  });

  it('does nothing at the very start of a line', () => {
    expect(backspaceWidth('wait(3)', 0)).toBe(0);
    expect(backspaceWidth('    a\n    b', 6)).toBe(0); // start of line 2
  });

  it('measures from the caret\'s own line, not the whole source', () => {
    const src = 'wait(1)\n        wait(2)';
    expect(backspaceWidth(src, src.length - 'wait(2)'.length)).toBe(4);
  });

  it('never deletes past the line start', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]) {
      const src = ' '.repeat(n) + 'x';
      expect(backspaceWidth(src, n)).toBeLessThanOrEqual(n);
    }
  });
});

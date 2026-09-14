/**
 * The editor's wiring, in a DOM.
 *
 * The pure logic is covered by state-script-tokens.test.ts. What this covers is the part that can
 * only break when it is assembled: that the highlight mirror reproduces the text character for
 * character (anything else slides the colours off), that a token actually receives its colour
 * class, and that the popup's keyboard behaviour inserts what was highlighted.
 *
 * Rendering the whole config page would need the entire app's context, so this exercises the same
 * primitives the editor is built from — the tokenizer's output mapped to spans, and the completion
 * source driven by caret offsets — against a real DOM.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { completionsAt, applyCompletion } from '@/lib/state-script-complete';
import { highlightSpans } from '@/lib/state-script-highlight';

const tables = {
  actuators: new Set(['FUEL_VENT', 'MAIN_VALVE']),
  sensors: new Set(['GN2_HIGH']),
  states: new Set(['IDLE', 'PRESS_STANDBY', 'FUEL_VENT']),
  allowedTransitions: new Set(['IDLE', 'PRESS_STANDBY']),
};

/**
 * The editor's ACTUAL mirror, not a reimplementation of it.
 *
 * Importing highlightSpans is the point: a copy of the span construction living in this file would
 * pass forever while the real one drifted, which is the failure mode these tests exist to catch.
 */
function Mirror({ src }: { src: string }) {
  return <pre data-testid="mirror">{highlightSpans(src, tables)}</pre>;
}

describe('highlight mirror', () => {
  /**
   * The mirror's text, minus the one intentional addition.
   *
   * highlightSpans appends a zero-width space so that a source ending in a newline still gives the
   * mirror a final line — without it the mirror is one line shorter than the textarea and the two
   * scroll out of step. It has no width, so it cannot shift anything; everything BEFORE it must be
   * exact.
   */
  const mirrorText = () => {
    const raw = screen.getByTestId('mirror').textContent ?? '';
    expect(raw.endsWith('​')).toBe(true);
    return raw.slice(0, -1);
  };

  it('reproduces the source character for character', () => {
    // The single most important property: the mirror sits behind the textarea, so if its text
    // differs by even one character the colours drift off the words — and drift further the
    // longer the line, which reads as intermittent rather than broken.
    const src = 'open_valve(FUEL_VENT)   # trailing\n    delay(0.25)\n\nwhile elapsed() < 5:\n';
    render(<Mirror src={src} />);
    expect(mirrorText()).toBe(src);
  });

  it('preserves indentation exactly', () => {
    const src = '        delay(1)\n';
    render(<Mirror src={src} />);
    expect(mirrorText()).toBe(src);
  });

  it('gives each kind its own colour', () => {
    const { container } = render(<Mirror src={'# c\nwhile elapsed() < 5:\n    open_valve(FUEL_VENT)\n'} />);
    const classOf = (kind: string) =>
      container.querySelector(`[data-kind="${kind}"]`)?.className ?? '';
    expect(classOf('comment')).toContain('text-gray-500');
    expect(classOf('keyword')).toContain('text-blue-300');
    expect(classOf('command')).toContain('text-purple-300');
    expect(classOf('valve')).toContain('text-amber-300');
    expect(classOf('number')).toContain('text-orange-300');
  });

  it('paints the same word differently in a valve slot and a state slot', () => {
    const { container } = render(
      <Mirror src={'open_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\n'} />,
    );
    const spans = [...container.querySelectorAll('span')].filter((s) => s.textContent === 'FUEL_VENT');
    expect(spans.map((s) => s.getAttribute('data-kind'))).toEqual(['valve', 'state']);
    expect(spans[0].className).toContain('text-amber-300');
    expect(spans[1].className).toContain('text-emerald-300');
  });

  it('underlines a name this config does not declare, and only that one', () => {
    const { container } = render(<Mirror src={'open_valve(FUEL_VNT)\nopen_valve(MAIN_VALVE)\n'} />);
    const spans = [...container.querySelectorAll('[data-kind="valve"]')];
    expect(spans[0].className).toContain('decoration-wavy');
    expect(spans[1].className).not.toContain('decoration-wavy');
  });
});

describe('completion, driven by caret offsets', () => {
  /** Accept the nth suggestion at the caret marked `|`, as the popup's Enter/Tab handler does. */
  const pick = (marked: string, n = 0) => {
    const caret = marked.indexOf('|');
    const src = marked.replace('|', '');
    const r = completionsAt(src, caret, tables)!;
    return applyCompletion(src, r, r.items[n]);
  };

  it('inserting a command leaves the caret inside its parens, ready for a name', () => {
    const r = completionsAt('', 0, tables)!;
    const cmd = r.items.find((i) => i.text === 'open_valve(')!;
    const out = applyCompletion('', r, cmd);
    expect(out.source).toBe('open_valve(');
    expect(out.caret).toBe('open_valve('.length);
    expect(cmd.reopen).toBe(true);
  });

  it('completing a valve replaces the typed prefix and closes the call', () => {
    expect(pick('open_valve(FU|').source).toBe('open_valve(FUEL_VENT)');
  });

  it('completing mid-line keeps what follows the caret', () => {
    expect(pick('open_valve(MA|)\ndelay(1)\n').source).toBe('open_valve(MAIN_VALVE)\ndelay(1)\n');
  });

  it('offers only reachable states in transition_to', () => {
    const r = completionsAt('transition_to(', 14, tables)!;
    expect(r.items.map((i) => i.label)).toEqual(['IDLE', 'PRESS_STANDBY']);
  });

  it('arrow-key selection picks the item that was highlighted', () => {
    // The popup tracks an index; Enter inserts items[index]. Picking index 1 must insert the
    // SECOND suggestion, not the first.
    const r = completionsAt('open_valve(', 11, tables)!;
    expect(r.items.length).toBeGreaterThan(1);
    expect(applyCompletion('open_valve(', r, r.items[1]).source).toBe('open_valve(MAIN_VALVE)');
  });

  it('a finished line offers nothing further, so Enter starts a new one', () => {
    // The bug this guards: after completing a call the caret sits at a position that used to fall
    // through to "expression", so the popup reopened and swallowed Enter — pressing it put a
    // second command on the same line instead of moving to the next.
    expect(completionsAt('open_valve(FUEL_VENT)', 21, tables)).toBeNull();
  });

  it('suggests nothing inside a comment, so typing prose is not interrupted', () => {
    expect(completionsAt('# open the FU', 13, tables)).toBeNull();
  });
});

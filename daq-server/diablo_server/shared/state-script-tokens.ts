/**
 * Tokenizer for dynamic-state scripts — one pass, no parse tree.
 *
 * Two features rest on this: syntax highlighting, and autocomplete. They need the same fact, which
 * is the one thing about this language that is not obvious from a token's spelling:
 *
 *   **What a name MEANS is decided by the call it sits inside, not by how it is written.**
 *
 * `FUEL_VENT` is a valve in `open_valve(FUEL_VENT)` and a state in `transition_to(FUEL_VENT)`, and
 * on the shipped `server` profile it is legitimately both. Highlighting it by spelling would paint
 * one of them wrong; suggesting by spelling would offer states where only valves belong. Deriving
 * both from one tokenizer is what keeps the popup and the colours from ever disagreeing.
 *
 * Deliberately NOT a parser. It has to work on half-typed text — `open_valve(FU` with the caret
 * still inside — which a parser rejects outright. Unclosed parens and garbage are normal input
 * here, so every rule degrades to `unknown` rather than throwing.
 */
import type { ScriptNameTables } from './state-script-names.js';

export type TokenKind =
  | 'comment'
  | 'number'
  | 'keyword' // if / elif / else / while / and / or / not
  | 'command' // a built-in call: open_valve, delay, pressure, …
  | 'valve' // a name in an open_valve/close_valve argument
  | 'sensor' // a name in a pressure() argument
  | 'state' // a name in a transition_to() argument
  | 'variable' // an identifier anywhere else
  | 'op' // punctuation and operators
  | 'unknown'; // a call that is not a built-in

export interface Token {
  start: number;
  end: number;
  text: string;
  kind: TokenKind;
  /** For valve/sensor/state only: whether the config actually declares this name. undefined when
   *  no tables were supplied, or the token is not a name. A false here is what turns a typo red
   *  as it is typed, rather than at save time. */
  known?: boolean;
}

const KEYWORDS = new Set(['if', 'elif', 'else', 'while', 'and', 'or', 'not']);

/** Built-ins, and which namespace their argument is drawn from. */
export const BUILTIN_ARG: Record<string, 'valve' | 'sensor' | 'state' | null> = {
  open_valve: 'valve',
  close_valve: 'valve',
  pressure: 'sensor',
  transition_to: 'state',
  delay: null, // takes an expression, not a name
  elapsed: null,
};

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => /[0-9]/.test(c);

function tableFor(kind: 'valve' | 'sensor' | 'state', t: ScriptNameTables): Set<string> {
  return kind === 'valve' ? t.actuators : kind === 'sensor' ? t.sensors : t.states;
}

/**
 * @param tables when supplied, name tokens gain `known`. For states, membership is checked against
 *        `states` rather than `allowedTransitions` — a real state the matrix forbids is a
 *        different problem from a name that does not exist, and colouring both red would conflate
 *        "you typo'd" with "you can't get there from here".
 */
export function tokenize(src: string, tables?: ScriptNameTables): Token[] {
  const out: Token[] = [];
  /** Names of the calls we are currently inside, innermost last. `pressure(` nested in a `delay(`
   *  argument is ordinary, so this has to be a stack rather than a single value. */
  const callStack: string[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '#') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      out.push({ start, end: i, text: src.slice(start, i), kind: 'comment' });
      continue;
    }

    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      // A newline ends any unclosed call. Without this, one stray `open_valve(` would colour the
      // rest of the file as valve names.
      if (c === '\n') callStack.length = 0;
      i++;
      continue;
    }

    if (isDigit(c)) {
      const start = i;
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) i++;
      out.push({ start, end: i, text: src.slice(start, i), kind: 'number' });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentChar(src[i])) i++;
      const text = src.slice(start, i);

      if (KEYWORDS.has(text)) {
        out.push({ start, end: i, text, kind: 'keyword' });
        continue;
      }

      // A '(' next (whitespace allowed) makes this a call rather than a name.
      let j = i;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
      if (src[j] === '(') {
        const isBuiltin = Object.prototype.hasOwnProperty.call(BUILTIN_ARG, text);
        out.push({ start, end: i, text, kind: isBuiltin ? 'command' : 'unknown' });
        continue;
      }

      // Not a call — so its meaning comes from the call enclosing it, if any.
      const enclosing = callStack[callStack.length - 1];
      const ns = enclosing ? BUILTIN_ARG[enclosing] : undefined;
      if (ns) {
        const tok: Token = { start, end: i, text, kind: ns };
        if (tables) tok.known = tableFor(ns, tables).has(text);
        out.push(tok);
      } else {
        out.push({ start, end: i, text, kind: 'variable' });
      }
      continue;
    }

    if (c === '(') {
      // Attach this paren to the identifier immediately before it, which is the call being opened.
      const prev = out[out.length - 1];
      callStack.push(prev && (prev.kind === 'command' || prev.kind === 'unknown') ? prev.text : '');
      out.push({ start: i, end: i + 1, text: c, kind: 'op' });
      i++;
      continue;
    }

    if (c === ')') {
      callStack.pop();
      out.push({ start: i, end: i + 1, text: c, kind: 'op' });
      i++;
      continue;
    }

    // Two-character operators first, so `<=` does not lex as `<` then `=`.
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      out.push({ start: i, end: i + 2, text: two, kind: 'op' });
      i += 2;
      continue;
    }

    out.push({ start: i, end: i + 1, text: c, kind: 'op' });
    i++;
  }

  return out;
}

/**
 * Which namespace a name typed at `caret` would belong to, and what has been typed of it.
 *
 * Works on incomplete text, which is the whole point: `open_valve(FU` with the caret at the end is
 * the normal case for a completion popup and is not something the tokenizer's call stack survives
 * to the end of, since the paren is never closed.
 *
 * Returns null inside a comment — nothing should be suggested there.
 */
export interface CaretContext {
  /** 'valve' | 'sensor' | 'state' — a name slot. 'command' — statement start. 'expr' — anywhere a
   *  value is allowed. */
  kind: 'valve' | 'sensor' | 'state' | 'command' | 'expr';
  /** What has been typed of the word under the caret. */
  prefix: string;
  /** Offsets of that partial word, so an accepted completion replaces exactly it. */
  from: number;
  to: number;
}

export function caretContext(src: string, caret: number): CaretContext | null {
  const lineStart = src.lastIndexOf('\n', caret - 1) + 1;
  const line = src.slice(lineStart, caret);

  // Inside a comment: suggest nothing.
  if (line.includes('#')) return null;

  // The partial word under the caret.
  const wordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
  const prefix = wordMatch ? wordMatch[1] : '';
  const from = caret - prefix.length;

  // Inside a built-in's argument list? Look for the nearest unclosed call on this line.
  const before = line.slice(0, line.length - prefix.length);
  const call = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/.exec(before);
  if (call) {
    const ns = BUILTIN_ARG[call[1]];
    if (ns) return { kind: ns, prefix, from, to: caret };
    // delay( and elapsed( take expressions, and an unknown call takes nothing useful.
    return { kind: 'expr', prefix, from, to: caret };
  }

  // Statement start — only indentation before the word.
  if (/^\s*$/.test(before)) return { kind: 'command', prefix, from, to: caret };

  // Everything else is a value position ONLY if something before it actually demands a value:
  // an assignment, an operator, an open paren, or a keyword that introduces a condition.
  //
  // Anything else means the line is already complete, and this language allows exactly one
  // statement per line — so after `open_valve(FUEL_VENT)` there is nothing further that could
  // legally go there. Suggesting anyway is not merely noise: the popup swallows Enter, so
  // finishing a call and pressing Enter for a new line would insert a second command on the same
  // one instead.
  const expectsValue = /[=+\-*/<>(,]\s*$/.test(before)
    || /\b(?:if|elif|while|and|or|not)\s+$/.test(before);
  if (expectsValue) return { kind: 'expr', prefix, from, to: caret };

  return null;
}

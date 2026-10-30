/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Nothing a person reads says psig (ADR 0007): the screen is psia, and the
 * one conversion is lib/pressure.ts. A label typed as a string anywhere else
 * is a pressure that skipped it -- the trip overlay, the Runs table and four
 * chart axes each did, and each read 14.7 psi off the one beside it.
 *
 * So every string the app could show is read from the source: string and
 * template literals and JSX text, with comments and identifiers left alone
 * (`knob.psig`, `pc_psig` and `drawn_psig` are wire fields, which stay gauge).
 * The exceptions are pressure.ts, which owns the gauge tag and the DAQ hover,
 * and the tests.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = new Set(['lib/pressure.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every literal text in a file that mentions psig, with its line. */
function gaugeText(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let literal: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literal = node.text;
    else if (ts.isJsxText(node)) literal = node.getText(source);
    if (literal !== null && /psig/i.test(literal)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1}: ${literal.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the screen says psia', () => {
  it('finds a psig a person could read, and not a wire field', () => {
    // The gate has to be able to fail: a label, a template and JSX text are
    // caught; a field name and a comment are not.
    const caught = gaugeText(
      'x.tsx',
      [
        "const a = 'Pressure (psig)';",
        'const b = `${v} psig`;',
        'const c = <span>psig</span>;',
        '// psig in a comment',
        'const d = knob.psig + series.pc_psig;',
      ].join('\n'),
    );
    expect(caught).toHaveLength(3);
  });

  it('no source file outside lib/pressure.ts shows psig', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(30);
    const offenders = files
      .filter((f) => !ALLOWED.has(relative(SRC, f).split('\\').join('/')))
      .flatMap((f) => gaugeText(relative(SRC, f), readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

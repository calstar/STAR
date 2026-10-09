import ts from 'typescript';

/**
 * The canvas's own code, cut out of PIDDesigner.tsx for the wiring tests.
 *
 * What the canvas does with a drop, a drag, a delete or a load is decided in
 * its handlers and effects, and those need React Flow and a DOM to mount; the
 * tests run them as written instead, compiled and handed stand-ins for what
 * they close over. They are found by the structure of the file, not by the
 * text around them: each is a statement of the canvas component, named by
 * how it opens -- `const onConnect = useCallback(`, or the comment that
 * heads an effect -- and taken whole, to its own end. Cut up to the next
 * doc comment, or up to a dependency array, a reworded comment or a
 * dependency added to a hook broke the tests of code nobody had touched, and
 * a dependency array that recurs cut straight on into the next effect.
 *
 * For the tests alone: nothing the app runs imports it.
 */

const SOURCE = Object.values(import.meta.glob('./PIDDesigner.tsx', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>)[0];

let statements: readonly ts.Statement[] | null = null;
let file: ts.SourceFile | null = null;

/** The top-level statements of the canvas component's body. */
function canvasBody(): readonly ts.Statement[] {
  if (statements) return statements;
  file = ts.createSourceFile('PIDDesigner.tsx', SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  for (const st of file.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'PIDCanvas' && st.body) statements = st.body.statements;
  }
  if (!statements) throw new Error('PIDDesigner.tsx no longer has the PIDCanvas component');
  return statements;
}

/** The index of the one statement that opens with `opening`, in its code or in the comment heading it. */
function indexOf(opening: string): number {
  const body = canvasBody();
  const hits: number[] = [];
  body.forEach((st, i) => {
    const own = st.getText(file!);
    const lead = SOURCE.slice(st.getFullStart(), st.getStart(file!));
    if (own.startsWith(opening) || lead.includes(opening)) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(`PIDDesigner.tsx has ${hits.length} statements of the canvas opening ${JSON.stringify(opening)}, not one`);
  }
  return hits[0];
}

/** The canvas statement that opens with `opening`, whole. */
export function canvasStatement(opening: string): string {
  return canvasBody()[indexOf(opening)].getText(file!);
}

/** The canvas statements from the one opening with `from` through the one opening with `through`, whole. */
export function canvasStatements(from: string, through: string): string {
  const i = indexOf(from), j = indexOf(through);
  if (j < i) throw new Error(`PIDDesigner.tsx has ${JSON.stringify(through)} before ${JSON.stringify(from)}`);
  const body = canvasBody();
  return SOURCE.slice(body[i].getStart(file!), body[j].getEnd());
}

/**
 * The expression a JSX prop of the canvas is set to -- an arrow function, as
 * a rule -- found by the text that opens the prop (its name and the arrow's
 * parameters, say), taken whole.
 */
export function canvasProp(opening: string): string {
  canvasBody();
  const hits: ts.JsxAttribute[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.getText(file!).startsWith(opening)) hits.push(n);
    ts.forEachChild(n, visit);
  };
  visit(file!);
  if (hits.length !== 1) throw new Error(`PIDDesigner.tsx has ${hits.length} props opening ${JSON.stringify(opening)}, not one`);
  const init = hits[0].initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) throw new Error(`${JSON.stringify(opening)} is not set to an expression`);
  return init.expression.getText(file!);
}

/**
 * The expression one element the canvas renders is given for a prop --
 * `onNodeDragStart` on `<ReactFlow>`, say -- as written, or null when it is
 * given none. The element is found by its tag, and must be the only one of
 * it; the prop by its name, not by the text round it, so a prop moved to
 * another line or another place in the tag is still found, and one taken
 * off is missed.
 */
export function canvasElementProp(tag: string, name: string): string | null {
  canvasBody();
  const hits: ts.JsxAttributes[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(file!) === tag) hits.push(n.attributes);
    ts.forEachChild(n, visit);
  };
  visit(file!);
  if (hits.length !== 1) throw new Error(`PIDDesigner.tsx renders ${hits.length} <${tag}> elements, not one`);
  const prop = hits[0].properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file!) === name) as ts.JsxAttribute | undefined;
  if (!prop) return null;
  const init = prop.initializer;
  if (!init) return 'true';
  if (ts.isJsxExpression(init)) return init.expression ? init.expression.getText(file!) : null;
  return init.getText(file!);
}

/** Code cut from the canvas, compiled as a function of `names` returning `result`. */
export function compiled(code: string, names: string[], result = 'undefined'): (...args: unknown[]) => unknown {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...names, `${js}\nreturn ${result};`) as (...args: unknown[]) => unknown;
}

/** The whole of PIDDesigner.tsx, for a test that checks only what it says. */
export const canvasSource = SOURCE;

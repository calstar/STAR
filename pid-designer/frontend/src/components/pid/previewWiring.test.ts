// How the canvas hands the previews what they need (PIDDesigner.tsx): the
// connection line React Flow draws a port drag with, the lookups the drop
// handlers use -- lent to the previews so they resolve a drop exactly as
// letting go will -- the line whose end is being carried, and the one-line
// hint. The canvas cannot be mounted here, so, as dropWiring.test.ts does,
// what PIDDesigner.tsx says is read, and its code cut out and run.
import { describe, expect, it } from 'vitest';
import { canvasSource as SOURCE, canvasStatement, compiled } from './canvasSource';

/** One JSX opening tag, as written. */
const tag = (name: string) => {
  const i = SOURCE.indexOf(`<${name}`);
  return SOURCE.slice(i, SOURCE.indexOf('>\n', SOURCE.indexOf(name, i)) + 1);
};
const prop = (props: string, name: string) => new RegExp(`\\b${name}=\\{([^}]*)\\}`).exec(props)?.[1];

describe('the canvas lends the previews', () => {
  it('a connection line of its own for a port drag, instead of React Flow\'s curve', () => {
    const i = SOURCE.indexOf('<ReactFlow\n');
    const props = SOURCE.slice(i, SOURCE.indexOf('\n      >\n', i));
    expect(prop(props, 'connectionLineComponent')).toBe('ConnectionLine');
    expect(SOURCE).toMatch(/import \{ ConnectionLine \} from '\.\/ConnectionLine';/);
  });

  it('the drop handlers\' own lookups, so a preview resolves a drop as letting go does', () => {
    const provider = tag('BranchDragProvider');
    expect(prop(provider, 'onDrop')).toBe('onBranchDrop');
    expect(prop(provider, 'scene')).toBe('dropScene');
    expect(prop(provider, 'under')).toBe('underPointer');
    expect(prop(provider, 'carrying')).toBe('carried');
    // The very lookups the handlers use: onConnectEnd and onBranchDrop resolve with these two.
    const handlers = SOURCE.slice(SOURCE.indexOf('const onConnectEnd = useCallback'), SOURCE.indexOf('const onDragOver'));
    expect(handlers.match(/underPointer\(client, at, scene/g)?.length).toBeGreaterThanOrEqual(3);
    expect(handlers.match(/const scene = dropScene\(\);/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('the line whose end is being carried, while one is, and none otherwise', () => {
    const connectingFrom = { current: null as null | { nodeId: string; handleId: string | null; reconnect?: string } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const carried = compiled(canvasStatement('const carried = useCallback('), ['useCallback', 'connectingFrom'], 'carried')(
      <T>(f: T) => f, connectingFrom) as () => string | null;
    expect(carried()).toBeNull();
    connectingFrom.current = { nodeId: 'A', handleId: 'r' };
    expect(carried()).toBeNull();
    connectingFrom.current = { nodeId: 'A', handleId: 'r', reconnect: 'A-B' };
    expect(carried()).toBe('A-B');
  });
});

describe('the hint', () => {
  it('is one line, and says a line is reshaped by clicking it', () => {
    const at = SOURCE.indexOf('<Panel position="bottom-center"');
    const panel = SOURCE.slice(at, SOURCE.indexOf('</Panel>', at));
    const span = /<span className="([^"]*)">\s*([^<]*?)\s*<\/span>/.exec(panel)!;
    expect(span[1].split(' ')).toEqual(expect.arrayContaining(['whitespace-nowrap', 'truncate']));
    expect(span[2]).toBe('Pull from a port or a line to draw · Click a line to reshape it · Drop a valve on a line to put it in · R rotates');
  });
});

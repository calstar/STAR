import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { propagateFluids, edgeFluid, declaredFluid } from './fluids';

const node = (id: string, componentType: string, data: Record<string, unknown> = {}): Node =>
  ({ id, position: { x: 0, y: 0 }, data: { componentType, label: id, ...data } }) as unknown as Node;

/** Handles matter: a tank's `t` port is its ullage side. See `isUllagePort`. */
const edge = (
  id: string, source: string, target: string,
  sourceHandle: string | null = null, targetHandle: string | null = null,
): Edge => ({ id, source, target, sourceHandle, targetHandle }) as unknown as Edge;

/** LOX and ethanol tanks feeding one engine, nitrogen pressurising both. */
function feedSystem() {
  const nodes = [
    node('TK-LOX', 'TANK', { fluid: 'oxygen' }),
    node('TK-ETH', 'TANK', { fluid: 'ethanol' }),
    node('TK-N2', 'TANK', { fluid: 'nitrogen' }),
    node('SOL-OX', 'SOL'),
    node('SOL-FU', 'SOL'),
    node('PR-1', 'PR'),
    node('MFLD', 'MANIFOLD'),
    node('ENG', 'ENGINE'),
  ];
  const edges = [
    edge('e1', 'TK-LOX', 'SOL-OX', 'b', 'l'),
    edge('e2', 'SOL-OX', 'MFLD'),
    edge('e3', 'MFLD', 'ENG'),
    edge('e4', 'TK-ETH', 'SOL-FU', 'b', 'l'),
    edge('e5', 'SOL-FU', 'ENG'),
    edge('e6', 'TK-N2', 'PR-1', 'b', 'l'),
    edge('e7', 'PR-1', 'TK-LOX', 'r', 't'),
  ];
  return { nodes, edges, fluids: propagateFluids(nodes, edges) };
}

describe('fluid propagates from the tanks that declare it', () => {
  it('paints everything downstream of a tank with that tank’s fluid', () => {
    const { fluids } = feedSystem();
    expect(fluids.get('SOL-OX')?.species).toBe('oxygen');
    expect(fluids.get('MFLD')?.species).toBe('oxygen');
    expect(fluids.get('SOL-FU')?.species).toBe('ethanol');
    expect(fluids.get('PR-1')?.species).toBe('nitrogen');
  });

  it('gives a line the fluid of the components it joins', () => {
    const { edges, fluids } = feedSystem();
    const of = (id: string) => edgeFluid(edges.find(e => e.id === id)!, fluids);
    expect(of('e1').species).toBe('oxygen');
    expect(of('e4').species).toBe('ethanol');
    expect(of('e6').species).toBe('nitrogen');
  });

  it('does not call a nitrogen-pressurised LOX tank a conflict', () => {
    // The single most common arrangement in the system, and the one an
    // earlier version flagged on every drawing: the ullage is nitrogen, the
    // outlet is LOX, and separating them is what the tank is for.
    const { fluids } = feedSystem();
    const tank = fluids.get('TK-LOX')!;
    expect(tank.species).toBe('oxygen');
    expect(tank.conflict).toBe(false);
    expect(tank.mixing).toBe(true);
  });

  it('does not let pressurant leak out of the tank it pressurises', () => {
    // If it did, the whole oxidiser side downstream would read as nitrogen.
    const { fluids } = feedSystem();
    expect(fluids.get('SOL-OX')?.species).toBe('oxygen');
    expect(fluids.get('MFLD')?.species).toBe('oxygen');
  });

  it('lets fuel and oxidiser meet at an engine without complaining', () => {
    const { fluids } = feedSystem();
    const eng = fluids.get('ENG')!;
    expect(eng.conflict).toBe(false);
    expect(eng.mixing).toBe(true);
  });

  it('does not paint the fuel side through the engine', () => {
    const { fluids } = feedSystem();
    // Whichever reached it first, nothing continues out the other side.
    expect(fluids.get('SOL-FU')?.species).toBe('ethanol');
    expect(fluids.get('SOL-OX')?.species).toBe('oxygen');
  });

  it('feeds a bottle connected only by its top port', () => {
    // A COPV drawn with its outlet at the top is still the source of what is
    // in it — the ullage rule defers that port, it does not silence it.
    const nodes = [node('COPV', 'TANK', { fluid: 'helium' }), node('PR-2', 'PR')];
    const edges = [edge('a', 'COPV', 'PR-2', 't', 'l')];
    expect(propagateFluids(nodes, edges).get('PR-2')?.species).toBe('helium');
  });

  it('reports a real conflict: two fluids at an ordinary component', () => {
    const nodes = [
      node('TK-LOX', 'TANK', { fluid: 'oxygen' }),
      node('TK-ETH', 'TANK', { fluid: 'ethanol' }),
      node('TEE', 'JUNCTION'),
    ];
    const edges = [edge('a', 'TK-LOX', 'TEE', 'b'), edge('b', 'TK-ETH', 'TEE', 'b')];
    const fluids = propagateFluids(nodes, edges);
    const tee = fluids.get('TEE')!;
    expect(tee.conflict).toBe(true);
    expect(tee.sources.sort()).toEqual(['TK-ETH', 'TK-LOX']);
  });

  it('leaves a component nothing feeds without a fluid', () => {
    const nodes = [node('SOL-1', 'SOL')];
    expect(propagateFluids(nodes, []).get('SOL-1')).toBeUndefined();
  });
});

describe('the four colour categories that came before species', () => {
  it('reads a legacy fluidType as the species it meant', () => {
    expect(declaredFluid({ componentType: 'TANK', label: 'x', fluidType: 'lox' })).toBe('oxygen');
    expect(declaredFluid({ componentType: 'TANK', label: 'x', fluidType: 'fuel' })).toBe('ethanol');
    expect(declaredFluid({ componentType: 'TANK', label: 'x', fluidType: 'pressurant' })).toBe('nitrogen');
  });

  it('treats the old "default" as undeclared rather than as a fluid', () => {
    expect(declaredFluid({ componentType: 'TANK', label: 'x', fluidType: 'default' })).toBeUndefined();
  });

  it('prefers an explicit species over the legacy field', () => {
    expect(declaredFluid({
      componentType: 'TANK', label: 'x', fluid: 'helium', fluidType: 'lox',
    })).toBe('helium');
  });
});

describe('lines that are meant to carry something else', () => {
  const typesOf = (nodes: Node[]) => new Map(nodes.map(n =>
    [n.id, (n.data as { componentType?: string }).componentType]));

  it('does not call a pressurant line into a tank a conflict', () => {
    // The most-drawn arrangement on any stand: nitrogen onto the ullage of a
    // LOX tank. The two ends genuinely hold different fluids, and the line
    // drew in the fault colour for it -- invisible while pressurant was red.
    const nodes = [
      node('KB-N2', 'KBOTTLE', { fluid: 'nitrogen' }),
      node('TK-LOX', 'TANK', { fluid: 'oxygen' }),
    ];
    const edges = [edge('u1', 'KB-N2', 'TK-LOX', 'r', 't')];
    const f = edgeFluid(edges[0], propagateFluids(nodes, edges), typesOf(nodes));
    expect(f.conflict).toBe(false);
    expect(f.species).toBe('nitrogen');
  });

  it('does not call the pilot gas on a dome a conflict', () => {
    // Helium domed onto a LOX regulator. The dome sets the setpoint; it never
    // joins the stream being regulated.
    const nodes = [
      node('TK-LOX', 'TANK', { fluid: 'oxygen' }),
      node('PR-1', 'PR'),
      node('KB-HE', 'KBOTTLE', { fluid: 'helium' }),
    ];
    const edges = [
      edge('p1', 'TK-LOX', 'PR-1', 'b', 'l'),
      edge('p2', 'KB-HE', 'PR-1', 'r', 'dome'),
    ];
    const fluids = propagateFluids(nodes, edges);
    const dome = edgeFluid(edges[1], fluids, typesOf(nodes));
    expect(dome.conflict).toBe(false);
    expect(dome.species).toBe('helium');
    // ...and the helium has not leaked into the regulator itself.
    expect(fluids.get('PR-1')?.species).toBe('oxygen');
    expect(fluids.get('PR-1')?.conflict).toBe(false);
  });

  it('still reports two fluids meeting on ordinary ports', () => {
    // The exemption is for the ports where a difference is the point. A LOX
    // line joined to an ethanol line is still the worst afternoon of your life.
    const nodes = [
      node('TK-LOX', 'TANK', { fluid: 'oxygen' }),
      node('TK-ETH', 'TANK', { fluid: 'ethanol' }),
      node('V', 'MAN'),
    ];
    const edges = [
      edge('x1', 'TK-LOX', 'V', 'b', 'l'),
      edge('x2', 'TK-ETH', 'V', 'b', 'r'),
    ];
    const fluids = propagateFluids(nodes, edges);
    expect(fluids.get('V')?.conflict).toBe(true);
  });
});

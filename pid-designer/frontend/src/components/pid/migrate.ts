import type { Edge, Node } from '@xyflow/react';

/**
 * What an older drawing means in today's vocabulary.
 *
 * Applied once, on load, so nothing downstream has to know a symbol was ever
 * called something else. Each rule names the change and the date it landed;
 * a rule is never removed, because a drawing can be any age.
 */
export function migrate(d: { nodes: Node[]; edges: Edge[] }): { nodes: Node[]; edges: Edge[] } {
  const nodes = d.nodes.map(n => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    // 2026-09: the standalone injector symbol is gone. It was the engine
    // without its chamber, and on a feed drawing that is the same boundary.
    if (n.type === 'INJECTOR' || data.componentType === 'INJECTOR') {
      return { ...n, type: 'ENGINE', data: { ...data, componentType: 'ENGINE' } } as Node;
    }
    return n;
  });
  return { nodes, edges: d.edges };
}

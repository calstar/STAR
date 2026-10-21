import type { Network } from './contract';

/**
 * The parts of a feed system by the names on the drawing. The recorded network keys every node and
 * branch by the graph's own ids (node_15, junc_49, node_2-junc_49), and a line on the drawing has no
 * tag of its own, so a line was printed as its id. Here a line is named by the drawn tags at its
 * ends ("DPR_HP → tee", "Eth-Tank → FM-R"), and no node_ or junc_ id ever reaches the page.
 */

/** A graph id (node_15, junc_49, node_2-junc_49, node_36.fuel) rather than a name. */
const RAW_ID = /^(?:node|junc)_[\w.:-]*$/;
/** A line's id: two graph ids joined by a hyphen (feed-twin names a line by its ends). */
const LINE_ID = /^((?:node|junc)_[\w.:]+)-((?:node|junc)_[\w.:]+)$/;

export const isRawId = (s: string | null | undefined): boolean => !!s && RAW_ID.test(s);

/** The part of a recorded network naming needs: its nodes, and (to name a symbol) its branches. */
export type NetNames = Pick<Network, 'nodes'> & Partial<Pick<Network, 'branches'>>;

const cleanLabel = (label: string) => label.replace(/\s+(?:outlet|inlet|ullage)$/i, '');

/** A node in words: its drawn tag without the port word ("Eth-Tank outlet" → "Eth-Tank"), a
 * junction as "tee", the injector's inlet as "injector". A symbol's own id (a valve's) is its tag. */
export function nodeWords(net: NetNames | null | undefined, id: string): string {
  const nodes = net?.nodes ?? {};
  const node = nodes[id];
  const kind = node?.kind ?? '';
  const label = (node?.label ?? '').trim();
  if (kind === 'junction' || /^junc_/.test(id)) return 'tee';
  if (kind === 'chamber' || /\.chamber$/.test(id)) return 'chamber';
  if (kind === 'injector_inlet' || /^Injector inlet/i.test(label) || /:manifold$/.test(id)) return 'injector';
  if (label && !isRawId(label)) return cleanLabel(label);
  // A symbol, not a node: the branch it is (a valve, a regulator), else its ports' node.
  const branch = net?.branches?.[id]?.label;
  if (branch && !isRawId(branch)) return branch;
  const owner = id.replace(/\.(?:in|out)$/, '');
  for (const k of [owner, `${owner}.out`, `${owner}.in`]) {
    const l = nodes[k]?.label;
    if (l && !isRawId(l) && nodes[k]?.kind !== 'injector_inlet') return cleanLabel(l);
  }
  // The engine symbol's own id: its nodes are the injector inlets and the chamber.
  if (Object.keys(nodes).some((k) => k.startsWith(`${owner}.`) && ['injector_inlet', 'chamber'].includes(nodes[k]?.kind ?? ''))) return 'injector';
  const ownBranch = net?.branches?.[owner]?.label;
  return ownBranch && !isRawId(ownBranch) ? ownBranch : 'line';
}

/** Free text with graph ids in it ("node_15 outlet -> injector"): each id as its drawn tag. */
export function scrubIds(net: NetNames | null | undefined, text: string): string {
  return text
    .replace(/\s*->\s*/g, ' → ')
    .replace(/\b((?:node|junc)_[A-Za-z0-9_]+(?:\.(?:in|out))?)\b/g, (id) => nodeWords(net, id));
}

/** What the injector branch's two halves are called (the backend's own words are a model note). */
const PART_WORDS: Record<string, string> = { dump: 'Into the manifold', orifice: 'Injector orifices' };

/**
 * A feed part's name for a person: an element of the pressure ladder, a network branch, a line in
 * the acoustics table. A part the drawing tags keeps its tag; a line is "from → to" by the tags at
 * its ends; the injector's halves are named for what they are.
 */
export function partName(net: NetNames | null | undefined,
                         part: { id?: string; label?: string | null; kind?: string; from?: string; to?: string }): string {
  const label = (part.label ?? '').trim();
  if (part.kind && PART_WORDS[part.kind]) return PART_WORDS[part.kind];
  const raw = !label || label === part.id || isRawId(label) || LINE_ID.test(label);
  if (!raw) return scrubIds(net, label);
  const ends = part.from && part.to ? [part.from, part.to] : LINE_ID.exec(label || part.id || '')?.slice(1, 3);
  if (ends && ends.length === 2) return `${nodeWords(net, ends[0])} → ${nodeWords(net, ends[1])}`;
  return part.kind === 'line' ? 'Line' : 'Part';
}

/** A tooltip for a named part: what kind of part, between which drawn tags. */
export function partTitle(net: NetNames | null | undefined,
                          part: { id?: string; label?: string | null; kind?: string; from?: string; to?: string }): string {
  const name = partName(net, part);
  const kind = part.kind === 'line' ? 'Line' : part.kind === 'tank_head' ? 'Liquid head' : part.kind ? part.kind[0].toUpperCase() + part.kind.slice(1) : '';
  return kind && !name.startsWith(kind) ? `${kind}: ${name}` : name;
}

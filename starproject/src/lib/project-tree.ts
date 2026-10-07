/**
 * The project hierarchy, any depth: LE4 › Engine › Spark igniter.
 *
 * Projects are stored flat (each points at its parent), and there are few
 * enough of them that callers load them all once and walk the tree here
 * rather than nesting `include: { children: … }` to some fixed depth.
 * Everything in this file is pure so it can be tested without a database.
 */

export type TreeNode = {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  archived: boolean;
};

export type ProjectTree = {
  byId: Map<string, TreeNode>;
  /** Children of each project (key null = top level), in the input order. */
  childrenOf: Map<string | null, TreeNode[]>;
};

export const PATH_SEPARATOR = " › ";

export function buildTree(nodes: TreeNode[]): ProjectTree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    // A parent that isn't in the list (shouldn't happen) leaves the node at
    // the top rather than losing it.
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const list = childrenOf.get(key) ?? [];
    list.push(n);
    childrenOf.set(key, list);
  }
  return { byId, childrenOf };
}

/** Root first, not including the project itself. Stops on a cycle, which the
 * move rules prevent but old data should never be able to hang a page with. */
export function ancestors(tree: ProjectTree, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  const seen = new Set([id]);
  let parentId = tree.byId.get(id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    const p = tree.byId.get(parentId);
    if (!p) break;
    out.unshift(p);
    seen.add(p.id);
    parentId = p.parentId;
  }
  return out;
}

/** Every project below this one, depth-first, not including itself. */
export function descendants(
  tree: ProjectTree,
  id: string,
  opts: { includeArchived?: boolean } = {},
): TreeNode[] {
  const out: TreeNode[] = [];
  const seen = new Set([id]);
  const walk = (parent: string) => {
    for (const c of tree.childrenOf.get(parent) ?? []) {
      if (seen.has(c.id) || (c.archived && !opts.includeArchived)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** "LE4 › Engine › Spark igniter". With `below`, the path starts under that
 * ancestor — on LE4's own page a task of Spark igniter reads "Engine › Spark
 * igniter". */
export function pathOf(tree: ProjectTree, id: string, below?: string): string {
  const node = tree.byId.get(id);
  if (!node) return "";
  let chain = [...ancestors(tree, id), node];
  if (below) {
    const at = chain.findIndex((n) => n.id === below);
    if (at >= 0) chain = chain.slice(at + 1);
  }
  return chain.map((n) => n.name).join(PATH_SEPARATOR);
}

/** The whole tree (or one branch) in display order, each with its depth —
 * for indented lists and pickers. Top-level projects are depth 0. */
export function flatten(
  tree: ProjectTree,
  opts: { includeArchived?: boolean; under?: string | null } = {},
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of tree.childrenOf.get(parent) ?? []) {
      if (seen.has(c.id) || (c.archived && !opts.includeArchived)) continue;
      seen.add(c.id);
      out.push({ node: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(opts.under ?? null, 0);
  return out;
}

/** Why `id` can't move under `newParentId`, or null if it can. A project can't
 * sit under itself or anything inside it — that would make a loop. */
export function moveProblem(
  tree: ProjectTree,
  id: string,
  newParentId: string | null,
): string | null {
  if (!newParentId) return null;
  if (newParentId === id) return "A project can't be its own parent.";
  if (!tree.byId.has(newParentId)) return "Parent project not found.";
  if (descendants(tree, id, { includeArchived: true }).some((d) => d.id === newParentId)) {
    return "A project can't move inside one of its own subprojects.";
  }
  return null;
}

/** Task count for a project and everything under it. */
export function totalTasks(
  tree: ProjectTree,
  id: string,
  ownCount: (id: string) => number,
): number {
  return [id, ...descendants(tree, id).map((d) => d.id)].reduce((n, pid) => n + ownCount(pid), 0);
}

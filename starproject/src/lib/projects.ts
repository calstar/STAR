import { cache } from "react";

import { prisma } from "@/lib/db";
import { buildTree, flatten, pathOf, type ProjectTree } from "@/lib/project-tree";

/** Every project (archived ones too, so old tasks still get a full path),
 * as a tree. Memoized per request — pages, labels and actions share it. */
export const getProjectTree = cache(async (): Promise<ProjectTree> => {
  const nodes = await prisma.project.findMany({
    select: { id: true, name: true, color: true, parentId: true, archived: true },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
  });
  return buildTree(nodes);
});

/** Active projects as picker options, labelled by full path ("LE4 › Engine ›
 * Spark igniter") and in tree order so subprojects sit under their parent. */
export async function getProjectOptions(): Promise<{ id: string; label: string }[]> {
  const tree = await getProjectTree();
  return flatten(tree).map(({ node }) => ({ id: node.id, label: pathOf(tree, node.id) }));
}

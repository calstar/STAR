import { describe, expect, it } from "vitest";

import {
  ancestors,
  buildTree,
  descendants,
  flatten,
  moveProblem,
  pathOf,
  totalTasks,
  type TreeNode,
} from "./project-tree";

const node = (id: string, parentId: string | null, archived = false): TreeNode => ({
  id,
  name: id,
  color: null,
  parentId,
  archived,
});

// LE4 ─┬─ Engine ─── Spark
//      ├─ Avionics
//      └─ Old (archived) ─── Leftover
// Media
const tree = buildTree([
  node("LE4", null),
  node("Engine", "LE4"),
  node("Spark", "Engine"),
  node("Avionics", "LE4"),
  node("Old", "LE4", true),
  node("Leftover", "Old"),
  node("Media", null),
]);

describe("project tree", () => {
  it("walks up to the root", () => {
    expect(ancestors(tree, "Spark").map((n) => n.id)).toEqual(["LE4", "Engine"]);
    expect(ancestors(tree, "LE4")).toEqual([]);
  });

  it("walks down every level, skipping archived branches unless asked", () => {
    expect(descendants(tree, "LE4").map((n) => n.id)).toEqual(["Engine", "Spark", "Avionics"]);
    expect(descendants(tree, "LE4", { includeArchived: true }).map((n) => n.id)).toEqual([
      "Engine",
      "Spark",
      "Avionics",
      "Old",
      "Leftover",
    ]);
  });

  it("names a project by its full path, or relative to an ancestor", () => {
    expect(pathOf(tree, "Spark")).toBe("LE4 › Engine › Spark");
    expect(pathOf(tree, "Spark", "LE4")).toBe("Engine › Spark");
    expect(pathOf(tree, "Media")).toBe("Media");
  });

  it("flattens in display order with depth", () => {
    expect(flatten(tree).map(({ node, depth }) => `${depth}:${node.id}`)).toEqual([
      "0:LE4",
      "1:Engine",
      "2:Spark",
      "1:Avionics",
      "0:Media",
    ]);
  });

  it("refuses moves that would make a loop", () => {
    expect(moveProblem(tree, "LE4", "Spark")).toMatch(/inside one of its own/);
    expect(moveProblem(tree, "Engine", "Engine")).toMatch(/own parent/);
    expect(moveProblem(tree, "LE4", "Leftover")).toMatch(/inside one of its own/); // archived still counts
    expect(moveProblem(tree, "Spark", "Avionics")).toBeNull();
    expect(moveProblem(tree, "Media", "Spark")).toBeNull(); // deeper nesting is fine
    expect(moveProblem(tree, "Spark", null)).toBeNull();
  });

  it("totals tasks across every level", () => {
    const own: Record<string, number> = { LE4: 1, Engine: 2, Spark: 4, Avionics: 8, Old: 16 };
    expect(totalTasks(tree, "LE4", (id) => own[id] ?? 0)).toBe(15);
    expect(totalTasks(tree, "Engine", (id) => own[id] ?? 0)).toBe(6);
  });

  it("survives a loop in stored data", () => {
    const loop = buildTree([node("A", "B"), node("B", "A")]);
    expect(ancestors(loop, "A").map((n) => n.id)).toEqual(["B"]);
    expect(pathOf(loop, "A")).toBe("B › A");
  });
});

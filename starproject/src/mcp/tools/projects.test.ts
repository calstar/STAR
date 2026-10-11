import { describe, expect, it } from "vitest";

import { buildTree, type TreeNode } from "@/lib/project-tree";

import { orderedProjectRows, projectRows, type ProjectDetails } from "./projects";

const node = (id: string, parentId: string | null, archived = false): TreeNode => ({
  id,
  name: id,
  color: null,
  parentId,
  archived,
});

// In creation order (getProjectTree orders by createdAt):
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

const own = new Map<string, number>([
  ["LE4", 1],
  ["Engine", 2],
  ["Spark", 4],
  ["Leftover", 8],
  ["Media", 16],
]);

const details = new Map<string, ProjectDetails>([
  ["LE4", { description: "The rocket", featured: true, trackOrder: 1, phases: ["Design", "Build"] }],
  ["Media", { description: null, featured: false, trackOrder: 0, phases: [] }],
]);

describe("list_projects shaping", () => {
  it("orders like the /projects page: newest top first, each branch after its top", () => {
    expect(orderedProjectRows(tree).map((r) => `${r.depth}:${r.node.id}`)).toEqual([
      "0:Media",
      "0:LE4",
      "1:Engine",
      "2:Spark",
      "1:Avionics",
    ]);
  });

  it("shows archived branches only when asked", () => {
    const ids = orderedProjectRows(tree, { includeArchived: true }).map((r) => `${r.depth}:${r.node.id}`);
    expect(ids).toEqual(["0:Media", "0:LE4", "1:Engine", "2:Spark", "1:Avionics", "1:Old", "2:Leftover"]);
  });

  it("carries path, own and rolled-up counts, and the extra columns", () => {
    const rows = projectRows(tree, own, details);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const le4 = byId.get("LE4")!;
    expect(le4.path).toBe("LE4");
    expect(le4.taskCount).toBe(1);
    // Own + Engine + Spark + Avionics; the archived Old branch (8) is not rolled up.
    expect(le4.totalTasks).toBe(1 + 2 + 4);
    expect(le4).toMatchObject({ description: "The rocket", featured: true, trackOrder: 1, phases: ["Design", "Build"] });

    const spark = byId.get("Spark")!;
    expect(spark.path).toBe("LE4 › Engine › Spark");
    expect(spark.depth).toBe(2);
    expect(spark.taskCount).toBe(4);
    expect(spark.totalTasks).toBe(4);

    // A project with no tasks and no details row still gets zeros and defaults.
    expect(byId.get("Avionics")).toMatchObject({
      taskCount: 0,
      totalTasks: 0,
      description: null,
      featured: false,
      trackOrder: 0,
      phases: [],
    });
  });

  it("keeps the tree node's own fields on each row", () => {
    const engine = projectRows(tree, own, details).find((r) => r.id === "Engine")!;
    expect(engine).toMatchObject({ name: "Engine", color: null, parentId: "LE4", archived: false, depth: 1 });
  });
});

import { describe, expect, it } from "vitest";

import { buildTree, type TreeNode } from "@/lib/project-tree";

import { projectTreeJson, taskJson, taskNumberOf, type TaskRecord } from "./resources";

const node = (id: string, parentId: string | null, archived = false): TreeNode => ({
  id,
  name: id,
  color: null,
  parentId,
  archived,
});

describe("projectTreeJson", () => {
  it("flattens in tree order with depth and full path, keeping archived projects flagged", () => {
    const tree = buildTree([
      node("LE4", null),
      node("Avionics", null, true),
      node("Engine", "LE4"),
      node("Igniter", "Engine"),
    ]);
    const rows = projectTreeJson(tree);
    expect(rows.map((r) => [r.id, r.depth, r.path, r.archived])).toEqual([
      ["LE4", 0, "LE4", false],
      ["Engine", 1, "LE4 › Engine", false],
      ["Igniter", 2, "LE4 › Engine › Igniter", false],
      ["Avionics", 0, "Avionics", true],
    ]);
    expect(rows[1].parentId).toBe("LE4");
  });
});

describe("taskNumberOf", () => {
  it("parses a positive integer, taking the first segment of an array", () => {
    expect(taskNumberOf("42")).toBe(42);
    expect(taskNumberOf(["7", "x"])).toBe(7);
  });

  it("refuses anything that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "007", undefined, []]) {
      expect(() => taskNumberOf(bad as string | string[] | undefined)).toThrow(/Not a task number/);
    }
  });
});

describe("taskJson", () => {
  const task: TaskRecord = {
    id: "t1",
    number: 12,
    title: "Order fittings",
    description: null,
    blockedNote: "waiting on PO",
    status: "in_progress",
    priority: "high",
    startDate: new Date("2026-10-01T00:00:00Z"),
    dueDate: null,
    archived: false,
    createdAt: new Date("2026-09-30T12:00:00Z"),
    updatedAt: new Date("2026-10-02T08:30:00Z"),
    project: { id: "p2", name: "Engine", archived: false },
    subteam: { id: "s1", name: "Propulsion" },
    assignees: [
      { id: "u1", email: "ada@berkeley.edu", name: "Ada Lovelace", displayName: null },
      { id: "u2", email: "bob@berkeley.edu", name: "Bob Builder", displayName: "Bobby" },
    ],
    blockedBy: [{ note: "needs quote", blockedByTask: { id: "t0", number: 11, title: "Get quote", status: "todo" } }],
  };

  it("renders dates as ISO, assignees by display name and blockers by number", () => {
    const out = taskJson(task, "LE4 › Engine");
    expect(out.startDate).toBe("2026-10-01");
    expect(out.dueDate).toBeNull();
    expect(out.createdAt).toBe("2026-09-30T12:00:00.000Z");
    expect(out.project).toEqual({ id: "p2", name: "Engine", path: "LE4 › Engine", archived: false });
    expect(out.assignees.map((a) => a.displayName)).toEqual(["Ada L.", "Bobby"]);
    expect(out.blockedBy).toEqual([{ taskId: "t0", number: 11, title: "Get quote", status: "todo", note: "needs quote" }]);
  });

  it("leaves subteam null when the task has none", () => {
    expect(taskJson({ ...task, subteam: null }, "x").subteam).toBeNull();
  });
});

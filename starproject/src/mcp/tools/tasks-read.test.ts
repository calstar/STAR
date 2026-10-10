import { describe, expect, it } from "vitest";

import { buildTree } from "@/lib/project-tree";

import {
  type TaskRow,
  buildTaskWhere,
  effectiveArchived,
  expandProjectIds,
  matchesInMemory,
  serializeTaskRow,
} from "./tasks-read";

// LE4 › Engine › Igniter, plus an archived subproject and a separate GSE root.
const tree = buildTree([
  { id: "le4", name: "LE4", color: null, parentId: null, archived: false },
  { id: "eng", name: "Engine", color: "#f00", parentId: "le4", archived: false },
  { id: "ign", name: "Igniter", color: null, parentId: "eng", archived: false },
  { id: "old", name: "Old", color: null, parentId: "le4", archived: true },
  { id: "gse", name: "GSE", color: null, parentId: null, archived: false },
]);

const ctx = { callerId: "me", tree };

const ada = { id: "u1", name: "Ada Lovelace", email: "ada@berkeley.edu", displayName: null };
const bob = { id: "u2", name: "Bob Ray", email: "bob@berkeley.edu", displayName: "Bobby" };

// A blocker edge as the include returns it (the edge's own columns plus the
// blocking task's id/title/status).
function blocker(status: TaskRow["status"]): TaskRow["blockedBy"][number] {
  return {
    id: "edge",
    taskId: "t1",
    blockedById: "t0",
    note: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    blockedByTask: { id: "t0", title: "Design", status },
  };
}

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    number: 42,
    projectId: "ign",
    project: { id: "ign", name: "Igniter", color: null },
    subteamId: "s1",
    subteam: { id: "s1", name: "Propulsion" },
    title: "Order fittings",
    description: null,
    blockedNote: null,
    status: "todo",
    priority: "high",
    assignees: [ada, bob],
    startDate: null,
    dueDate: new Date("2020-01-05T00:00:00Z"),
    boardOrder: 0,
    archived: false,
    createdById: "u1",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date("2026-01-02T10:00:00Z"),
    blockedBy: [],
    ...over,
  };
}

describe("expandProjectIds", () => {
  const active = { includeSubprojects: true, includeArchived: false };

  it("adds active descendants at every depth, skipping archived ones", () => {
    expect(expandProjectIds(tree, ["le4"], active).sort()).toEqual(["eng", "ign", "le4"]);
  });

  it("includes archived subprojects when asked", () => {
    expect(expandProjectIds(tree, ["le4"], { ...active, includeArchived: true }).sort()).toEqual([
      "eng", "ign", "le4", "old",
    ]);
  });

  it("returns just the ids when subprojects are not wanted", () => {
    expect(expandProjectIds(tree, ["le4", "gse"], { ...active, includeSubprojects: false })).toEqual(["le4", "gse"]);
  });

  it("dedupes a parent and its child", () => {
    expect(expandProjectIds(tree, ["le4", "eng"], active).sort()).toEqual(["eng", "ign", "le4"]);
  });

  it("rejects an unknown project id instead of returning nothing", () => {
    expect(() => expandProjectIds(tree, ["nope"], active)).toThrow(/Project not found: nope/);
  });
});

describe("effectiveArchived", () => {
  it("defaults to active, or all when done is among the statuses", () => {
    expect(effectiveArchived({})).toBe("active");
    expect(effectiveArchived({ status: ["todo"] })).toBe("active");
    expect(effectiveArchived({ status: ["todo", "done"] })).toBe("all");
  });

  it("never overrides an explicit choice", () => {
    expect(effectiveArchived({ status: ["done"], archived: "active" })).toBe("active");
    expect(effectiveArchived({ archived: "archived" })).toBe("archived");
  });
});

describe("buildTaskWhere", () => {
  it("defaults to active tasks only, with no other narrowing", () => {
    expect(buildTaskWhere({}, ctx)).toEqual({ archived: false });
  });

  it("maps the archived tri-state", () => {
    expect(buildTaskWhere({ archived: "archived" }, ctx)).toEqual({ archived: true });
    expect(buildTaskWhere({ archived: "all" }, ctx)).toEqual({});
  });

  it("filters by status, subteam and (expanded) project", () => {
    const where = buildTaskWhere(
      { status: ["todo", "done"], subteamIds: ["s1"], projectIds: ["eng"] },
      ctx,
    );
    expect(where.status).toEqual({ in: ["todo", "done"] });
    expect(where.subteamId).toEqual({ in: ["s1"] });
    expect(where.projectId).toEqual({ in: ["eng", "ign"] });
  });

  it("reaches archived subprojects only when archived tasks are in scope", () => {
    expect(buildTaskWhere({ projectIds: ["le4"], archived: "all" }, ctx).projectId).toEqual({
      in: ["le4", "eng", "ign", "old"],
    });
    expect(buildTaskWhere({ projectIds: ["le4"] }, ctx).projectId).toEqual({ in: ["le4", "eng", "ign"] });
  });

  it("widens to all when only done is asked for", () => {
    expect(buildTaskWhere({ status: ["done"] }, ctx)).toEqual({ status: { in: ["done"] } });
  });

  it("honours includeSubprojects=false", () => {
    expect(buildTaskWhere({ projectIds: ["eng"], includeSubprojects: false }, ctx).projectId).toEqual({
      in: ["eng"],
    });
  });

  it("ignores empty arrays", () => {
    expect(buildTaskWhere({ status: [], projectIds: [], subteamIds: [], assigneeIds: [] }, ctx)).toEqual({
      archived: false,
    });
  });

  it("ANDs `mine` with an explicit assignee filter", () => {
    expect(buildTaskWhere({ mine: true, assigneeIds: ["u2"] }, ctx).AND).toEqual([
      { assignees: { some: { id: { in: ["u2"] } } } },
      { assignees: { some: { id: "me" } } },
    ]);
  });

  it("treats due bounds as inclusive calendar days", () => {
    expect(buildTaskWhere({ dueAfter: "2026-03-01", dueBefore: "2026-03-31" }, ctx).dueDate).toEqual({
      gte: new Date("2026-03-01T00:00:00.000Z"),
      lte: new Date("2026-03-31T23:59:59.999Z"),
    });
    expect(buildTaskWhere({ dueBefore: "2026-03-31" }, ctx).dueDate).toEqual({
      lte: new Date("2026-03-31T23:59:59.999Z"),
    });
  });

  it("leaves search, overdue and blocked to the in-memory pass", () => {
    expect(buildTaskWhere({ search: "x", overdue: true, blocked: false }, ctx)).toEqual({ archived: false });
  });
});

describe("serializeTaskRow", () => {
  it("flattens a row with the project path, display names and derived flags", () => {
    const out = serializeTaskRow(
      row({ blockedBy: [blocker("in_progress")] }),
      tree,
    );
    expect(out).toEqual({
      id: "t1",
      number: 42,
      title: "Order fittings",
      status: "todo",
      priority: "high",
      project: { id: "ign", name: "Igniter", path: "LE4 › Engine › Igniter" },
      subteam: { id: "s1", name: "Propulsion" },
      assignees: [
        { id: "u1", displayName: "Ada L.", email: "ada@berkeley.edu" },
        { id: "u2", displayName: "Bobby", email: "bob@berkeley.edu" },
      ],
      startDate: null,
      dueDate: "2020-01-05",
      archived: false,
      blocked: true,
      overdue: true,
      blockedBy: [{ id: "t0", title: "Design", status: "in_progress" }],
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-02T10:00:00.000Z",
    });
    expect("subproject" in out).toBe(false);
  });

  it("is not overdue once done, nor blocked by a finished blocker", () => {
    const out = serializeTaskRow(
      row({ status: "done", blockedBy: [blocker("done")] }),
      tree,
    );
    expect(out.overdue).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("nulls out a missing subteam, priority and dates", () => {
    const out = serializeTaskRow(row({ subteamId: null, subteam: null, priority: null, dueDate: null }), tree);
    expect(out.subteam).toBeNull();
    expect(out.priority).toBeNull();
    expect(out.dueDate).toBeNull();
    expect(out.overdue).toBe(false);
  });

  it("tags a subproject's task with its path below the scoped project", () => {
    const out = serializeTaskRow(row({ project: { id: "ign", name: "Igniter", color: "#0f0" } }), tree, {
      below: "le4",
    });
    expect(out.subproject).toEqual({ name: "Engine › Igniter", color: "#0f0" });
    const own = serializeTaskRow(row({ projectId: "le4", project: { id: "le4", name: "LE4", color: null } }), tree, {
      below: "le4",
    });
    expect(own.subproject).toBeNull();
  });
});

describe("matchesInMemory", () => {
  const r = serializeTaskRow(row(), tree);

  it("searches title, project path, subteam and assignee names, case-insensitively", () => {
    expect(matchesInMemory(r, { search: "FITTINGS" })).toBe(true);
    expect(matchesInMemory(r, { search: "engine" })).toBe(true);
    expect(matchesInMemory(r, { search: "propulsion" })).toBe(true);
    expect(matchesInMemory(r, { search: "bobby" })).toBe(true);
    expect(matchesInMemory(r, { search: "ada l." })).toBe(true);
    expect(matchesInMemory(r, { search: "turbopump" })).toBe(false);
  });

  it("matches overdue and blocked in both directions, and ignores them when unset", () => {
    expect(matchesInMemory(r, {})).toBe(true);
    expect(matchesInMemory(r, { overdue: true })).toBe(true);
    expect(matchesInMemory(r, { overdue: false })).toBe(false);
    expect(matchesInMemory(r, { blocked: false })).toBe(true);
    expect(matchesInMemory(r, { blocked: true })).toBe(false);
  });
});

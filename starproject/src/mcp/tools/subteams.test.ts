import { describe, expect, it } from "vitest";

import { subteamRows } from "./subteams";

const created = new Date("2026-01-02T03:04:05.000Z");

describe("list_subteams shaping", () => {
  it("carries the list columns, both counts, and ISO dates", () => {
    const rows = subteamRows(
      [
        { id: "s1", name: "Avionics", color: "#f00", createdAt: created, _count: { tasks: 7 } },
        { id: "s2", name: "Structures", color: null, createdAt: created, _count: { tasks: 0 } },
      ],
      new Map([["s1", 3]]),
    );
    expect(rows).toEqual([
      {
        id: "s1",
        name: "Avionics",
        color: "#f00",
        createdAt: "2026-01-02T03:04:05.000Z",
        taskCount: 7,
        activeTaskCount: 3,
      },
      {
        id: "s2",
        name: "Structures",
        color: null,
        createdAt: "2026-01-02T03:04:05.000Z",
        taskCount: 0,
        activeTaskCount: 0,
      },
    ]);
  });

  it("keeps the order it was given (the page sorts by name in SQL)", () => {
    const rows = subteamRows(
      [
        { id: "b", name: "B", color: null, createdAt: created, _count: { tasks: 1 } },
        { id: "a", name: "A", color: null, createdAt: created, _count: { tasks: 1 } },
      ],
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

import { describe, expect, it } from "vitest";

import { statusChangePatch } from "@/lib/tasks";

describe("statusChangePatch", () => {
  const now = new Date("2026-10-13T12:00:00Z");

  it("archives and stamps completedAt when a task enters Done", () => {
    expect(statusChangePatch("in_progress", "done", now)).toEqual({ archived: true, completedAt: now });
    expect(statusChangePatch("todo", "done", now)).toEqual({ archived: true, completedAt: now });
  });

  it("unarchives and clears completedAt when a task leaves Done", () => {
    expect(statusChangePatch("done", "in_progress", now)).toEqual({ archived: false, completedAt: null });
    expect(statusChangePatch("done", "todo", now)).toEqual({ archived: false, completedAt: null });
  });

  it("leaves archived and completedAt untouched when the transition doesn't cross Done", () => {
    expect(statusChangePatch("todo", "in_progress", now)).toEqual({});
    expect(statusChangePatch("backlog", "blocked", now)).toEqual({});
  });

  it("no-ops when the status is unchanged, so reordering a Done card keeps its date", () => {
    expect(statusChangePatch("done", "done", now)).toEqual({});
    expect(statusChangePatch("todo", "todo", now)).toEqual({});
  });
});

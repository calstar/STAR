import { describe, expect, it } from "vitest";

import { ACTIVITY_KINDS, activitySummary, buildActivityWhere } from "./activity";

const ada = { name: "Ada Lovelace", email: "ada@berkeley.edu", displayName: null };
const row = (over: Partial<Parameters<typeof activitySummary>[0]>) => ({
  kind: "updated",
  field: null,
  fromValue: null,
  toValue: null,
  taskTitle: "Order fittings",
  actor: ada,
  ...over,
});

describe("buildActivityWhere", () => {
  it("is empty with no filters, like /activity with no query string", () => {
    expect(buildActivityWhere({})).toEqual({});
  });

  it("treats empty strings as no filter, like an unset ?kind=", () => {
    expect(buildActivityWhere({ kind: "" as never, actorId: "", projectId: "", taskId: "" })).toEqual({});
  });

  it("maps each filter to its column", () => {
    expect(
      buildActivityWhere({ kind: "assigned", actorId: "u1", projectId: "p1", taskId: "t1" }),
    ).toEqual({ kind: "assigned", actorId: "u1", projectId: "p1", taskId: "t1" });
  });

  it("builds a half-open time window", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-10-08T00:00:00Z");
    expect(buildActivityWhere({ since, until })).toEqual({ createdAt: { gte: since, lt: until } });
    expect(buildActivityWhere({ since })).toEqual({ createdAt: { gte: since } });
    expect(buildActivityWhere({ until })).toEqual({ createdAt: { lt: until } });
  });

  it("lists every ActivityKind the filter accepts", () => {
    expect([...ACTIVITY_KINDS].sort()).toEqual(
      ["assigned", "blocker_added", "blocker_removed", "created", "deleted", "unassigned", "updated"].sort(),
    );
  });
});

describe("activitySummary", () => {
  it("names the actor the way the app does (First L.)", () => {
    expect(activitySummary(row({ kind: "created" }))).toBe("Ada L. created “Order fittings”");
    expect(
      activitySummary(row({ kind: "created", actor: { ...ada, displayName: "Ada" } })),
    ).toBe("Ada created “Order fittings”");
  });

  it("matches ActivityLine wording for every kind", () => {
    expect(activitySummary(row({ kind: "deleted" }))).toBe("Ada L. deleted task “Order fittings”");
    expect(activitySummary(row({ kind: "assigned", toValue: "Grace H." }))).toBe(
      "Ada L. assigned Grace H. to “Order fittings”",
    );
    expect(activitySummary(row({ kind: "unassigned", toValue: "Grace H." }))).toBe(
      "Ada L. unassigned Grace H. from “Order fittings”",
    );
    expect(activitySummary(row({ kind: "blocker_added", toValue: "Receive PO" }))).toBe(
      "Ada L. added a blocker to “Order fittings”: Receive PO",
    );
    expect(activitySummary(row({ kind: "blocker_removed", toValue: "Receive PO" }))).toBe(
      "Ada L. removed a blocker from “Order fittings”: Receive PO",
    );
    expect(activitySummary(row({ kind: "something_new" }))).toBe("Ada L. updated “Order fittings”");
  });

  it("labels the changed field and dashes missing values", () => {
    expect(
      activitySummary(row({ kind: "updated", field: "due", fromValue: "no date", toValue: "2026-10-20" })),
    ).toBe("Ada L. changed due date of “Order fittings” from no date to 2026-10-20");
    expect(activitySummary(row({ kind: "updated", field: "status", fromValue: "Todo", toValue: null }))).toBe(
      "Ada L. changed status of “Order fittings” from Todo to —",
    );
    // An unknown field falls back to its raw name rather than disappearing.
    expect(activitySummary(row({ kind: "updated", field: "colour", fromValue: "red", toValue: "blue" }))).toBe(
      "Ada L. changed colour of “Order fittings” from red to blue",
    );
  });
});

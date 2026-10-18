import { describe, expect, it } from "vitest";

import { adminEmailSet, countsByStatus, pickByEmail, userSummary } from "./users";

const created = new Date("2026-03-04T05:06:07.000Z");

describe("userSummary", () => {
  it("uses displayNameOf and flags admins case-insensitively", () => {
    // Mixed case on both sides: the admin list and the stored email each
    // need lowercasing for the match to hold.
    const admins = adminEmailSet([{ email: "ada@Berkeley.EDU" }]);
    expect(
      userSummary(
        { id: "u1", email: "Ada@berkeley.edu", name: "Ada Lovelace", displayName: null, createdAt: created },
        admins,
        4,
      ),
    ).toEqual({
      id: "u1",
      email: "Ada@berkeley.edu",
      name: "Ada Lovelace",
      displayName: "Ada L.",
      isAdmin: true,
      createdAt: "2026-03-04T05:06:07.000Z",
      openTaskCount: 4,
    });
  });

  it("prefers a chosen display name and marks non-admins false", () => {
    const s = userSummary(
      { id: "u2", email: "bob@berkeley.edu", name: "Robert Smith", displayName: "Bobby", createdAt: created },
      adminEmailSet([]),
      0,
    );
    expect(s.displayName).toBe("Bobby");
    expect(s.isAdmin).toBe(false);
  });

  it("never carries settings or tokens", () => {
    const s = userSummary(
      { id: "u3", email: "c@berkeley.edu", name: null, displayName: null, createdAt: created },
      adminEmailSet([]),
      0,
    );
    expect(Object.keys(s).sort()).toEqual(
      ["createdAt", "displayName", "email", "id", "isAdmin", "name", "openTaskCount"].sort(),
    );
    expect(s.displayName).toBe("c@berkeley.edu");
  });
});

describe("countsByStatus", () => {
  it("fills every status with zero and overlays the groups", () => {
    expect(
      countsByStatus([
        { status: "todo", _count: { _all: 2 } },
        { status: "done", _count: { _all: 5 } },
      ]),
    ).toEqual({ backlog: 0, todo: 2, in_progress: 0, done: 5, blocked: 0 });
  });

  it("is all zeros for no groups", () => {
    expect(Object.values(countsByStatus([]))).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("pickByEmail", () => {
  const rows = [{ email: "Ada@berkeley.edu" }, { email: "ada@berkeley.edu" }];

  it("prefers the exact match when case variants coexist", () => {
    expect(pickByEmail("ada@berkeley.edu", rows)).toEqual({ email: "ada@berkeley.edu" });
  });

  it("accepts a single case-insensitive match", () => {
    expect(pickByEmail("ADA@berkeley.edu", [rows[0]])).toEqual({ email: "Ada@berkeley.edu" });
  });

  it("refuses to guess between case variants with no exact match", () => {
    expect(() => pickByEmail("ADA@berkeley.edu", rows)).toThrow(/Ambiguous email/);
  });

  it("returns null for no match", () => {
    expect(pickByEmail("x@berkeley.edu", [])).toBeNull();
  });
});

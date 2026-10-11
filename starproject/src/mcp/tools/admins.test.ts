import { describe, expect, it } from "vitest";

import { classifyAdmins } from "./admins";

describe("classifyAdmins", () => {
  it("marks seed admins and runtime-added admins", () => {
    const seeds = ["Seed@Berkeley.edu", "other@berkeley.edu"];
    expect(
      classifyAdmins([{ email: "added@berkeley.edu" }, { email: "seed@berkeley.edu" }], seeds),
    ).toEqual([
      { email: "added@berkeley.edu", seed: false },
      { email: "seed@berkeley.edu", seed: true },
    ]);
  });

  it("compares emails case-insensitively", () => {
    expect(classifyAdmins([{ email: "SEED@berkeley.edu" }], ["seed@berkeley.edu"])).toEqual([
      { email: "SEED@berkeley.edu", seed: true },
    ]);
  });

  it("keeps the order it was given and handles an empty list", () => {
    expect(classifyAdmins([], ["seed@berkeley.edu"])).toEqual([]);
  });
});

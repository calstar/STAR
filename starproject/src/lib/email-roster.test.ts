import { describe, expect, it } from "vitest";

import { effectiveEmails } from "./email-roster";

describe("effectiveEmails", () => {
  it("is the seed list minus removed seeds plus additions, lowercased", () => {
    const got = effectiveEmails(["A@berkeley.edu", "b@berkeley.edu"], ["C@gmail.com"], ["a@berkeley.edu"]);
    expect([...got].sort()).toEqual(["b@berkeley.edu", "c@gmail.com"]);
  });
  it("brings a removed seed back when it is added again", () => {
    expect(effectiveEmails(["a@x.org"], ["a@x.org"], ["a@x.org"]).has("a@x.org")).toBe(true);
  });
});

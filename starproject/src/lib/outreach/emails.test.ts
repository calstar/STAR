import { describe, expect, it } from "vitest";

import { checkEmail, normalizeEmail, splitEmails, suggestFix } from "./emails";

describe("normalizeEmail", () => {
  it("lowercases, trims and strips export junk", () => {
    expect(normalizeEmail("  Foo.Bar@Gmail.COM ")).toBe("foo.bar@gmail.com");
    expect(normalizeEmail("dana\\_smith@bank.example")).toBe("dana_smith@bank.example");
    expect(normalizeEmail("mailto:a@b.com")).toBe("a@b.com");
    expect(normalizeEmail("Ada Lovelace <Ada@Example.org>")).toBe("ada@example.org");
    expect(normalizeEmail("abc@berkeley.edu?")).toBe("abc@berkeley.edu");
  });
});

describe("checkEmail", () => {
  it("rejects placeholders people typed instead of an address", () => {
    expect(checkEmail("kevin whatever his email is").ok).toBe(false);
    expect(checkEmail("Santiago").ok).toBe(false);
    expect(checkEmail(" @gmail.com").ok).toBe(false);
    expect(checkEmail("").ok).toBe(false);
    expect(checkEmail("Eduardo's dad's email ask the man").ok).toBe(false);
  });
  it("accepts a real address and flags a mistyped domain", () => {
    expect(checkEmail("a@gmail.com")).toEqual({ ok: true, email: "a@gmail.com", suggestion: null });
    expect(checkEmail("p@berkeley.efu")).toEqual({ ok: true, email: "p@berkeley.efu", suggestion: "p@berkeley.edu" });
  });
});

describe("suggestFix", () => {
  it("knows the common typos and leaves good domains alone", () => {
    expect(suggestFix("x@gmial.com")).toBe("x@gmail.com");
    expect(suggestFix("x@berkeley.edy")).toBe("x@berkeley.edu");
    expect(suggestFix("x@berkeley.edu")).toBeNull();
  });
});

describe("splitEmails", () => {
  it("pulls every address out of a multi-address cell, once each", () => {
    expect(
      splitEmails("ana.b.kim@acme.com, lee.j.park8@acme.com / Ana.B.Kim@acme.com"),
    ).toEqual(["ana.b.kim@acme.com", "lee.j.park8@acme.com"]);
    expect(splitEmails("abc@berkeley.edu?, defg@berkeley.edu?")).toEqual([
      "abc@berkeley.edu",
      "defg@berkeley.edu",
    ]);
    expect(splitEmails("Eduardo's dad's email ask the man")).toEqual([]);
  });
});

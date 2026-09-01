import { describe, expect, it } from "vitest";

import { displayNameOf, shortName } from "@/lib/names";

describe("shortName", () => {
  it("returns first name + last initial", () => {
    expect(shortName("Ada Lovelace")).toBe("Ada L.");
  });

  it("uses the last token for multi-part names", () => {
    expect(shortName("Mary Jane Watson")).toBe("Mary W.");
  });

  it("passes a single-word name through unchanged", () => {
    expect(shortName("Aidan")).toBe("Aidan");
  });

  it("falls back to the email when the name is empty", () => {
    expect(shortName("", "a@b.com")).toBe("a@b.com");
    expect(shortName(null, "a@b.com")).toBe("a@b.com");
    expect(shortName("   ", "a@b.com")).toBe("a@b.com");
  });

  it("returns an empty string when nothing is provided", () => {
    expect(shortName(null)).toBe("");
    expect(shortName(undefined)).toBe("");
  });
});

describe("displayNameOf", () => {
  it("prefers a custom displayName verbatim", () => {
    expect(
      displayNameOf({ displayName: "Johnny", name: "John Doe", email: "j@b.com" }),
    ).toBe("Johnny");
  });

  it("falls back to the short form when displayName is blank/whitespace", () => {
    expect(displayNameOf({ displayName: "", name: "John Doe" })).toBe("John D.");
    expect(displayNameOf({ displayName: "   ", name: "John Doe" })).toBe("John D.");
    expect(displayNameOf({ displayName: null, name: "John Doe" })).toBe("John D.");
  });

  it("falls back to the short form when there is no displayName", () => {
    expect(displayNameOf({ name: "Ada Lovelace" })).toBe("Ada L.");
    expect(displayNameOf({ name: null, email: "a@b.com" })).toBe("a@b.com");
  });
});

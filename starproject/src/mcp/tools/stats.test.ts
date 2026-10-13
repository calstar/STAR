import { describe, expect, it } from "vitest";

import { STAT_WINDOWS, parseWindow } from "@/lib/stats";

import { windowSchema } from "./stats";

describe("contribution_stats window schema", () => {
  it("defaults to 30d, the page's default", () => {
    expect(windowSchema.parse(undefined)).toBe("30d");
    expect(parseWindow(undefined)).toBe("30d");
  });

  it("accepts every window the page offers, and the page accepts every one the schema does", () => {
    for (const w of STAT_WINDOWS) {
      expect(windowSchema.parse(w)).toBe(w);
      expect(parseWindow(w)).toBe(w);
    }
    for (const w of windowSchema.removeDefault().options) expect(parseWindow(w)).toBe(w);
  });

  it("rejects anything else with a zod error rather than silently falling back", () => {
    // The page forgives a bad ?window= (parseWindow -> 30d); an API caller
    // asked for something specific and should hear that it does not exist.
    for (const bad of ["90d", "7D", "", "week", 7]) {
      const r = windowSchema.safeParse(bad);
      expect(r.success, String(bad)).toBe(false);
    }
  });
});

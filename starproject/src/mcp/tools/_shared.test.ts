import { describe, expect, it } from "vitest";
import { z } from "zod";

import { describeError, redirectTarget, toFormData } from "./_shared";

describe("toFormData", () => {
  it("omits undefined, clears with null, joins arrays, formats dates", () => {
    const fd = toFormData({
      title: "x",
      skip: undefined,
      clear: null,
      ids: ["a", "b", null],
      when: new Date("2026-10-09T15:00:00Z"),
      n: 3,
      on: true,
    });
    expect(fd.has("skip")).toBe(false);
    expect(fd.get("clear")).toBe("");
    expect(fd.get("ids")).toBe("a,b");
    expect(fd.get("when")).toBe("2026-10-09");
    expect(fd.get("n")).toBe("3");
    expect(fd.get("on")).toBe("true");
  });
});

describe("redirectTarget", () => {
  it("reads the path out of a Next redirect error and ignores everything else", () => {
    expect(redirectTarget({ digest: "NEXT_REDIRECT;replace;/projects/abc;307;" })).toBe("/projects/abc");
    expect(redirectTarget(new Error("nope"))).toBeNull();
    expect(redirectTarget(null)).toBeNull();
  });
});

describe("describeError", () => {
  it("flattens zod errors into one readable line", () => {
    const r = z.object({ title: z.string().min(1) }).safeParse({ title: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(describeError(r.error)).toMatch(/Invalid input.*title/);
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

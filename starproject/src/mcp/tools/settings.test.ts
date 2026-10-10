import { describe, expect, it } from "vitest";

import { DIGEST_KINDS } from "@/lib/digest";

import { digestKindSchema, splitFollows } from "./settings";

describe("splitFollows", () => {
  it("splits subscription rows into followed projects and subteams, sorted by name", () => {
    const rows = [
      { project: { id: "p2", name: "Zeta" }, subteam: null },
      { project: null, subteam: { id: "s1", name: "Propulsion" } },
      { project: { id: "p1", name: "Alpha" }, subteam: null },
      { project: null, subteam: { id: "s2", name: "Avionics" } },
    ];
    expect(splitFollows(rows)).toEqual({
      projects: [
        { id: "p1", name: "Alpha" },
        { id: "p2", name: "Zeta" },
      ],
      subteams: [
        { id: "s2", name: "Avionics" },
        { id: "s1", name: "Propulsion" },
      ],
    });
  });

  it("drops a row whose project or subteam no longer exists", () => {
    expect(splitFollows([{ project: null, subteam: null }])).toEqual({ projects: [], subteams: [] });
  });

  it("returns empty lists for no subscriptions", () => {
    expect(splitFollows([])).toEqual({ projects: [], subteams: [] });
  });
});

describe("digestKindSchema", () => {
  it("accepts every key in DIGEST_KINDS and nothing else", () => {
    for (const [kind] of DIGEST_KINDS) expect(digestKindSchema.parse(kind)).toBe(kind);
    expect(digestKindSchema.options).toEqual(DIGEST_KINDS.map(([kind]) => kind));
    expect(digestKindSchema.safeParse("Task created").success).toBe(false);
    expect(digestKindSchema.safeParse("").success).toBe(false);
  });
});

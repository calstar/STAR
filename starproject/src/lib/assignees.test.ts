import { describe, expect, it } from "vitest";

import { selectedFirst } from "@/lib/assignees";

const roster = ["ana", "ben", "cy", "dee", "eli"].map((id) => ({ id }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("selectedFirst", () => {
  it("lifts the selected people above everyone else", () => {
    const { top, rest } = selectedFirst(roster, new Set(["dee", "ben"]));
    expect(ids(top)).toEqual(["ben", "dee"]);
    expect(ids(rest)).toEqual(["ana", "cy", "eli"]);
  });

  it("keeps the roster's order inside each group, not the selection's", () => {
    const { top } = selectedFirst(roster, new Set(["eli", "ana"]));
    expect(ids(top)).toEqual(["ana", "eli"]);
  });

  it("changes nothing when no one is selected", () => {
    const { top, rest } = selectedFirst(roster, new Set());
    expect(top).toEqual([]);
    expect(ids(rest)).toEqual(ids(roster));
  });

  it("ignores a selected id that is not in the (filtered) list", () => {
    const { top, rest } = selectedFirst(roster.slice(0, 2), new Set(["eli", "ben"]));
    expect(ids(top)).toEqual(["ben"]);
    expect(ids(rest)).toEqual(["ana"]);
  });
});

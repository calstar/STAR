import { describe, expect, it } from "vitest";

import { orgFromTaskTitle } from "./tracker";

describe("orgFromTaskTitle", () => {
  it("reads the Correspondence - X (note) titles", () => {
    expect(orgFromTaskTitle("Correspondence - Garmin (inReach satellite communicators for desert recovery)")).toEqual({
      orgName: "Garmin",
      ask: "inReach satellite communicators for desert recovery",
      renewal: false,
    });
    expect(orgFromTaskTitle("Correspondence - Cobra Firing Systems (renewal)")).toEqual({
      orgName: "Cobra Firing Systems",
      ask: null,
      renewal: true,
    });
    expect(orgFromTaskTitle("Correspondence - AVCO (renewal - valves)")).toEqual({
      orgName: "AVCO",
      ask: "valves",
      renewal: true,
    });
    expect(orgFromTaskTitle("Correspondence - SGA")).toEqual({ orgName: "SGA", ask: null, renewal: false });
  });
  it("reads 'X sponsorship' titles and ignores the rest", () => {
    expect(orgFromTaskTitle("Swage Sponsorship")?.orgName).toBe("Swage");
    expect(orgFromTaskTitle("Get PT sponsorship")?.orgName).toBe("PT");
    expect(
      orgFromTaskTitle('Swagelok - request sponsorship/discount on 3/8" Swagelok-to-NPT fittings, 700 psi check valves'),
    ).toEqual({ orgName: "Swagelok", ask: 'request sponsorship/discount on 3/8" Swagelok-to-NPT fittings, 700 psi check valves', renewal: false });
    expect(
      orgFromTaskTitle("Source COPV tanks - 6 L minimum, 4500 psi rating - identify vendors and request sponsorship/discount"),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { orgAliases, sameOrg } from "./orgs";

describe("sameOrg", () => {
  it("matches the board's names to the sponsor sheet's", () => {
    expect(sameOrg("Dassault Systemes / SolidWorks", "Dassault Systems")).toBe(true);
    expect(sameOrg("Onshape / PTC", "Onshape")).toBe(true);
    expect(sameOrg("MJG Technologies / electricmatch", "MJG")).toBe(true);
    expect(sameOrg("Moffett Field / NASA Ames", "Moffit Field / NASA Ames")).toBe(true);
    expect(sameOrg("EcoFlow / Jackery", "Jackery")).toBe(true);
    expect(sameOrg("Blue Origin", "blue origin, inc.")).toBe(true);
  });
  it("keeps different orgs apart", () => {
    expect(sameOrg("Rocket.Supplies", "Rocket Lab")).toBe(false);
    expect(sameOrg("Desktop Metal", "Online Metals")).toBe(false);
    expect(sameOrg("3D Systems", "Dassault Systems")).toBe(false);
    expect(sameOrg("GM", "GoPro")).toBe(false);
    expect(sameOrg("Engineering Student Council", "Engineering Student Services")).toBe(false);
  });
  it("lists each side of a slash", () => {
    expect(orgAliases("Onshape / PTC")).toEqual(["onshape ptc", "onshape", "ptc"]);
  });
});

import { describe, expect, it } from "vitest";

import { describeSegment, matchesSegment, segmentWhere, type SegmentRow } from "./segments";

const row = (o: Partial<SegmentRow> = {}): SegmentRow => ({
  email: "a@x.com",
  firstName: "Ada",
  lastName: "Lovelace",
  notes: null,
  tags: [],
  affiliation: null,
  doNotContact: false,
  bounced: false,
  org: null,
  donationCampaignIds: [],
  ...o,
});

describe("matchesSegment", () => {
  it("leaves out do-not-contact and bounced people unless asked", () => {
    expect(matchesSegment({}, row({ doNotContact: true }))).toBe(false);
    expect(matchesSegment({}, row({ bounced: true }))).toBe(false);
    expect(matchesSegment({ includeExcluded: true }, row({ doNotContact: true }))).toBe(true);
  });
  it("tags: any, all, none", () => {
    const c = row({ tags: ["alumni", "donor"] });
    expect(matchesSegment({ tagsAny: ["family", "alumni"] }, c)).toBe(true);
    expect(matchesSegment({ tagsAll: ["alumni", "family"] }, c)).toBe(false);
    expect(matchesSegment({ tagsNone: ["donor"] }, c)).toBe(false);
  });
  it("campaign non-donors: asked but not given", () => {
    const f = { tagsAny: ["crowdfunding-2026"], notDonatedTo: "c26" };
    expect(matchesSegment(f, row({ tags: ["crowdfunding-2026"] }))).toBe(true);
    expect(matchesSegment(f, row({ tags: ["crowdfunding-2026"], donationCampaignIds: ["c26"] }))).toBe(false);
    expect(matchesSegment({ donatedTo: "any" }, row({ donationCampaignIds: ["c25"] }))).toBe(true);
    expect(matchesSegment({ donatedTo: "c26" }, row({ donationCampaignIds: ["c25"] }))).toBe(false);
  });
  it("sponsor stage, optionally per season", () => {
    const c = row({ org: { name: "Boeing", kind: "company", deals: [{ stage: "committed", season: "2025–26" }] } });
    expect(matchesSegment({ dealStages: ["committed"] }, c)).toBe(true);
    expect(matchesSegment({ dealStages: ["committed"], dealSeason: "2026–27" }, c)).toBe(false);
    expect(matchesSegment({ search: "boe" }, c)).toBe(true);
  });
});

describe("alumni filters", () => {
  it("class-year range and has-phone", () => {
    const a = row({ affiliation: "alumni", gradYear: 2019, phone: "+16505550199" });
    const b = row({ affiliation: "alumni", gradYear: 2023, phone: null });
    const f = { affiliations: ["alumni"], gradYearMin: 2018, gradYearMax: 2020 };
    expect(matchesSegment(f, a)).toBe(true);
    expect(matchesSegment(f, b)).toBe(false);
    expect(matchesSegment({ hasPhone: true }, a)).toBe(true);
    expect(matchesSegment({ hasPhone: true }, b)).toBe(false);
    expect(matchesSegment({ gradYearMin: 2018 }, row())).toBe(false);
    expect(describeSegment({ affiliations: ["alumni"], gradYearMin: 2019, gradYearMax: 2019, hasPhone: true })).toBe(
      "Everyone alumni, class of 2019, with a phone number",
    );
    expect(segmentWhere({ hasPhone: true, gradYearMin: 2018 })).toEqual({
      AND: [{ doNotContact: false, bounced: false }, { phone: { not: null } }, { gradYear: { gte: 2018 } }],
    });
  });
});

describe("segmentWhere", () => {
  it("always excludes do-not-contact by default and adds one clause per criterion", () => {
    expect(segmentWhere({})).toEqual({ AND: [{ doNotContact: false, bounced: false }] });
    expect(segmentWhere({ includeExcluded: true })).toEqual({});
    const w = segmentWhere({ tagsAny: ["a"], notDonatedTo: "c" }) as { AND: unknown[] };
    expect(w.AND).toHaveLength(3);
    expect(w.AND).toContainEqual({ donations: { none: { campaignId: "c" } } });
  });
});

describe("describeSegment", () => {
  it("reads like a sentence", () => {
    expect(describeSegment({})).toBe("Everyone");
    expect(describeSegment({ tagsAny: ["alumni"], notDonatedTo: "c" }, () => "October 2026")).toBe(
      "Everyone tagged alumni, who haven't given to October 2026",
    );
  });
});

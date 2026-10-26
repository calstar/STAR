import { describe, expect, it } from "vitest";

import { parseDelimited } from "./csv";
import { leadingAmount, planImport, planSummary, type ImportOptions } from "./importer";

const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({
  preset: "auto",
  tags: [],
  affiliation: null,
  campaignId: null,
  season: "2026–27",
  applyFixes: false,
  source: "test",
  ...o,
});

const sheet = (lines: string[]) => parseDelimited(lines.join("\n"), "\t", true);

describe("member list (NAME | EMAILS)", () => {
  const rows = sheet([
    "NAME\tEMAILS",
    "Ada L.\tmom@gmail.com",
    "\tdad@yahoo.com",
    "\t",
    "\tkevin whatever his email is",
    "Grace H.\tpat@berkeley.efu",
    "\tMOM@gmail.com",
  ]);

  it("detects the layout and fills the member down their block", () => {
    const plan = planImport(rows, opts({ tags: ["crowdfunding-2026"], affiliation: "family" }));
    expect(plan.preset).toBe("member_list");
    const mom = plan.contacts.find((c) => c.email === "mom@gmail.com")!;
    const dad = plan.contacts.find((c) => c.email === "dad@yahoo.com")!;
    expect(dad.ambassadors).toEqual([{ email: null, name: "Ada L." }]);
    expect(dad.affiliation).toBe("family");
    expect(dad.tags).toEqual(["crowdfunding-2026"]);
    // The same parent on two members' lists is one contact with both referrals.
    expect(mom.ambassadors.map((a) => a.name)).toEqual(["Ada L.", "Grace H."]);
    expect(plan.merged).toBe(1);
  });

  it("rejects placeholders and flags typos without fixing unless asked", () => {
    const plan = planImport(rows, opts());
    expect(plan.rejected).toEqual([{ row: 5, reason: 'not an address: "kevin whatever his email is"' }]);
    expect(plan.flagged).toEqual([{ row: 6, email: "pat@berkeley.efu", suggestion: "pat@berkeley.edu", applied: false }]);
    expect(plan.contacts.map((c) => c.email)).toContain("pat@berkeley.efu");
    const fixed = planImport(rows, opts({ applyFixes: true }));
    expect(fixed.contacts.map((c) => c.email)).toContain("pat@berkeley.edu");
  });
});

describe("contact list with a referrer (2024 Friends and Family)", () => {
  it("separates the contact from the member who referred them", () => {
    const rows = sheet([
      "First Name\tLast name\tEmail address\tContact First Name\tContact Last Name\tEmail Sent",
      "Jo\tSmith\tjo@x.com\tAda\tLovelace\tFALSE",
      "\t\tnobody@x.com\t\t\tFALSE",
    ]);
    const plan = planImport(rows, opts({ affiliation: "friend" }));
    expect(plan.preset).toBe("contacts");
    expect(plan.contacts[0]).toMatchObject({
      email: "jo@x.com",
      firstName: "Jo",
      lastName: "Smith",
      affiliation: "friend",
      ambassadors: [{ email: null, name: "Ada Lovelace" }],
    });
    expect(plan.contacts[1].email).toBe("nobody@x.com");
  });

  it("keeps an alternate email and splits a full name", () => {
    const rows = sheet(["Name\tEmail\tAlternate Email Address", "B and J Kim\tbj@x.com\tbj2@y.com"]);
    const [c] = planImport(rows, opts()).contacts;
    expect(c).toMatchObject({ firstName: "B and J", lastName: "Kim", altEmails: ["bj2@y.com"] });
  });
});

describe("ScaleFunder export", () => {
  const header =
    "proj_name,date_created,first_name,last_name,email,address,address2,city,state,zipcode,country,phone,channel,amount,perk_name,donor_display,ambassador_first_name,ambassador_last_name,ambassador_email,sf_id";
  const rows = parseDelimited(
    [
      header,
      'STAR,2025-10-14 09:12:00,Lee,Park,lee@yahoo.com,1 Main St,,Berkeley,CA,94704,US,,ScaleFunder,"$2,000.00",Launch Anything On A Rocket,hide_amount,Ada,L,ada@berkeley.edu,SF1',
      "STAR,2025-10-15 10:00:00,Lee,Park,LEE@yahoo.com,,,,,,,,ScaleFunder,75,Signed Polaroid From Launch,display,Cal Student,Philanthropy,studentgiving@berkeley.edu,SF2",
      "STAR,2025-10-15 10:00:00,No,Amount,x@y.com,,,,,,,,ScaleFunder,,,display,,,,SF3",
    ].join("\n"),
    ",",
  );

  it("reads gifts with idempotent refs and folds a repeat donor into one contact", () => {
    const plan = planImport(rows, opts());
    expect(plan.preset).toBe("scalefunder");
    expect(plan.donations).toHaveLength(2);
    expect(plan.donations[0]).toMatchObject({
      email: "lee@yahoo.com",
      amountCents: 200000,
      perkName: "Launch Anything On A Rocket",
      displayPref: "hide_amount",
      ambassadorEmail: "ada@berkeley.edu",
      externalRef: "SF1",
    });
    expect(plan.donations[0].donatedAt.startsWith("2025-10-14")).toBe(true);
    const lee = plan.contacts.find((c) => c.email === "lee@yahoo.com")!;
    expect(lee.tags).toContain("donor");
    expect(lee.address).toBe("1 Main St");
    // The campus default "Cal Student Philanthropy" is not a member.
    expect(lee.ambassadors).toEqual([{ email: "ada@berkeley.edu", name: "Ada L" }]);
    expect(plan.donations[1].ambassadorEmail).toBeNull();
    expect(plan.rejected).toEqual([{ row: 4, reason: "no amount" }]);
    expect(planSummary(plan)).toMatchObject({ donations: 2, donationCents: 207500 });
  });
});

describe("Current Sponsors List", () => {
  const rows = sheet([
    "g\tSponsorships",
    "\tSponsorships\t\t\t\t\tLast updated: 4/14/26",
    "Name\tSponsorship type\tProject\tRes Engineer\tContact\tTheir Deliverables\tOur Deliverables\tStatus\tAddt Info\tTimeline",
    "Boeing\tMonetary\tFull Team\t\tana@boeing.com, raj@boeing.com\t$3,000.00\t\tCurrent\t\t",
    "GM\tMonetary\tFull Team\t\tpat.k@gm.com\t$10,000.00\t\tPlanned\tThey ghsoted us :(\t",
    "BakTek\tResources\tFull Team\t\tEduardo's dad's email ask the man\t\t\tCurrent\t\t",
    "Jacobs Institute\tDiscounts\tFull Team\t\tmaker@berkeley.edu\t50% off MakerPasses\t\tCurrent\t\t",
  ]);

  it("finds the header under the banner and makes one deal per sponsor", () => {
    const plan = planImport(rows, opts());
    expect(plan.preset).toBe("sponsors");
    expect(plan.headerRow).toBe(3);
    expect(plan.deals.map((d) => [d.orgName, d.type, d.stage, d.renewal, d.valueCents])).toEqual([
      ["Boeing", "monetary", "prospect", true, 300000],
      ["GM", "monetary", "ghosted", false, 1000000],
      ["BakTek", "in_kind", "prospect", true, null],
      ["Jacobs Institute", "discount", "prospect", true, null],
    ]);
    expect(plan.deals[3].orgKind).toBe("campus");
    expect(plan.deals[2].notes).toContain("Eduardo's dad");
    expect(plan.contacts.filter((c) => c.orgName === "Boeing").map((c) => c.email)).toEqual([
      "ana@boeing.com",
      "raj@boeing.com",
    ]);
  });
});

describe("no header", () => {
  it("says what it needs", () => {
    const plan = planImport([["just", "some"], ["words", "here"]], opts());
    expect(plan.rejected[0].reason).toMatch(/header/);
  });
});

describe("leadingAmount", () => {
  it("reads dollar amounts and leaves counts and percentages alone", () => {
    expect(leadingAmount("$3,000.00")).toBe(300000);
    expect(leadingAmount("8330 (outreach only)")).toBe(833000);
    expect(leadingAmount("$500 in credits")).toBe(50000);
    expect(leadingAmount("2 Go3s, 1 X3")).toBeNull();
    expect(leadingAmount("15%")).toBeNull();
    expect(leadingAmount("50% off MakerPasses")).toBeNull();
    expect(leadingAmount("???")).toBeNull();
  });
});

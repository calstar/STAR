import { describe, expect, it } from "vitest";

import { mapScrapedRecord, parseTag, subjectTag, uidFrom } from "@/lib/finance/callink-import";
import { scrapedRecord } from "@/lib/finance/fixtures";

describe("mapScrapedRecord", () => {
  const m = mapScrapedRecord(scrapedRecord());

  it("mirrors CalLink's numbers and status", () => {
    expect(m.callinkId).toBe(1800001);
    expect(m.mirror.callinkRequestNumber).toBe("1860001");
    expect(m.mirror.callinkStatus).toBe("Approved");
    expect(m.mirror.submittedAmountCents).toBe(12345);
    expect(m.mirror.submittedOn?.toISOString()).toBe("2026-05-01T12:00:00.000Z");
    expect(m.request.amountCents).toBe(12345);
  });

  it("pulls the UID, email and phone out of the free-text answers", () => {
    expect(m.pii).toEqual({
      street: "1 Analytical Way", street2: "Apt 2", city: "Berkeley", state: "CA", zip: "94704",
      phone: "5105550100", uid: "7654321",
    });
    expect(m.request.payeeEmail).toBe("ada@berkeley.edu");
    expect(m.request.submitterEmail).toBe("ada@berkeley.edu");
  });

  it("keeps PII out of the fields everyone sees", () => {
    expect(JSON.stringify(m.request)).not.toMatch(/7654321|5105550100|Analytical/);
    expect(JSON.stringify(m.items)).not.toMatch(/7654321|5105550100|Analytical/);
  });

  it("reads payment and direct-deposit answers", () => {
    expect(m.request.expenditureAction).toBe("Direct Deposit");
    expect(m.request.directDepositSignedUp).toBe(true);
  });

  it("maps items, unparseable totals and receipt links", () => {
    expect(m.items.map((i) => i.amountCents)).toEqual([10000, 2345, null]);
    expect(m.items[2].amountText).toBe("N/A");
    expect(m.items[0].receipts).toEqual([
      {
        fileName: "mcmaster.pdf",
        mimeType: "application/pdf",
        callinkDocumentId: "11",
        callinkHref: "https://callink.berkeley.edu/actionCenter/organization/STAR/Finance/FileUploadQuestion/getdocument?DocumentId=11&RespondentId=22",
      },
    ]);
  });

  it("finds our tag in a subject we filed", () => {
    expect(mapScrapedRecord(scrapedRecord({ name: "Motor casing [STAR R-42]" })).tagNumber).toBe(42);
    expect(m.tagNumber).toBeNull();
  });

  it("falls back to the submitter's name when the payee has none", () => {
    const rec = scrapedRecord();
    rec.detail.payee = null;
    const out = mapScrapedRecord(rec);
    expect(out.request.payeeFirstName).toBe("Ada");
    expect(out.request.payeeLastName).toBe("Lovelace");
    expect(out.pii).toBeNull();
  });
});

describe("uidFrom", () => {
  it("never takes a student ID for a UID", () => {
    expect(uidFrom("YES, … social security number) 3031234567")).toBeNull();
    expect(uidFrom("YES, … social security number) 3031234")).toBeNull();
    expect(uidFrom("No, this is not a current UCB student")).toBeNull();
    expect(uidFrom("YES … https://www.berkeley.edu/directory/ … 12345678")).toBe("12345678");
  });
});

describe("tags", () => {
  it("round-trips", () => {
    expect(parseTag(`Fittings${subjectTag(7)}`)).toBe(7);
    expect(parseTag("Fittings [STAR R-7] extra")).toBeNull();
  });
});

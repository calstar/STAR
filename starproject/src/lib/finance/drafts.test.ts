import { describe, expect, it } from "vitest";

import { draftPatchSchema, draftProblems, mergeDraft } from "@/lib/finance/drafts";

const complete = {
  subject: "Avionics parts",
  payee: { firstName: "Ada", lastName: "Lovelace", street: "1 Main St", city: "Berkeley", state: "CA", zip: "94720" },
  uid: "1234567",
  email: "ada@berkeley.edu",
  phone: "510-555-0100",
  items: [{ date: "2026-10-01", vendor: "Digikey", amount: "12.34" }],
};

describe("draftPatchSchema", () => {
  it("takes a half-filled item and payee", () => {
    const p = draftPatchSchema.parse({ payee: { firstName: "Ada" }, items: [{ vendor: "Digikey" }] });
    expect(p).toEqual({ payee: { firstName: "Ada" }, items: [{ vendor: "Digikey" }] });
  });

  it("still checks a value once it is given", () => {
    expect(draftPatchSchema.safeParse({ email: "not an email" }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ uid: "30312345" }).success).toBe(false);
  });

  it("refuses fields the form doesn't have", () => {
    expect(draftPatchSchema.safeParse({ amountCents: 5 }).success).toBe(false);
  });
});

describe("mergeDraft", () => {
  it("replaces fields given, merges the payee, replaces items whole, keeps the rest", () => {
    const prev = { subject: "Old", payee: { firstName: "Ada", city: "Berkeley" }, items: [{ vendor: "A" }, { vendor: "B" }] };
    const next = mergeDraft(prev, { subject: "New", payee: { city: "Oakland" }, items: [{ vendor: "C" }] });
    expect(next).toEqual({ subject: "New", payee: { firstName: "Ada", city: "Oakland" }, items: [{ vendor: "C" }] });
  });
});

describe("draftProblems", () => {
  it("is empty for a complete draft with a receipt per item", () => {
    expect(draftProblems(complete, [0])).toEqual([]);
  });

  it("lists what the form would refuse, and missing receipts", () => {
    const p = draftProblems({ ...complete, email: undefined, items: [...complete.items, { vendor: "Mouser" }] }, [0]);
    expect(p).toContain("email: Required");
    expect(p.some((x) => x.startsWith("items.1.date:"))).toBe(true);
    expect(p).toContain("items.1.receipt: Attach the receipt");
  });

  it("flags a receipt left behind by a shortened item list", () => {
    expect(draftProblems(complete, [0, 2])).toEqual(["receipts.2: A receipt is attached for item 2, which the draft doesn't have"]);
  });

  it("asks for an item on an empty draft", () => {
    expect(draftProblems({}, [])).toContain("items: Required");
  });
});

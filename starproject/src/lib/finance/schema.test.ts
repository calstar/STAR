import { describe, expect, it } from "vitest";

import { reimbursementInputSchema, uidSchema } from "@/lib/finance/schema";

const valid = {
  subject: "Test reimbursement",
  payee: { firstName: "Ada", lastName: "Lovelace", street: "1 Main St", city: "Berkeley", state: "ca", zip: "94704" },
  uid: "1234567",
  email: "Ada@Berkeley.edu",
  phone: "(510) 555-0100",
  items: [{ date: "2026-10-02", vendor: "McMaster-Carr", amount: "12.34" }],
};

describe("reimbursementInputSchema", () => {
  it("accepts a minimal request and fills STAR's defaults", () => {
    const r = reimbursementInputSchema.parse(valid);
    expect(r.expenditureAction).toBe("Direct Deposit");
    expect(r.directDepositSignedUp).toBe(true);
    expect(r.email).toBe("ada@berkeley.edu");
    expect(r.payee.state).toBe("CA");
  });

  it("refuses fields STAR fixes, so a request cannot carry them", () => {
    for (const extra of [{ account: "SUMMARY" }, { category: "Awards" }, { amount: "500" }, { requestedAmount: "5" }]) {
      expect(reimbursementInputSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it("needs 1 to 6 items with real totals", () => {
    expect(reimbursementInputSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
    const seven = Array.from({ length: 7 }, () => valid.items[0]);
    expect(reimbursementInputSchema.safeParse({ ...valid, items: seven }).success).toBe(false);
    for (const amount of ["0", "N/A", "12.345", ""]) {
      expect(reimbursementInputSchema.safeParse({ ...valid, items: [{ ...valid.items[0], amount }] }).success).toBe(false);
    }
  });

  it("needs special instructions when payment is Other", () => {
    expect(reimbursementInputSchema.safeParse({ ...valid, expenditureAction: "Other" }).success).toBe(false);
    expect(
      reimbursementInputSchema.safeParse({ ...valid, expenditureAction: "Other", specialInstructions: "Pick up" }).success,
    ).toBe(true);
  });
});

describe("uidSchema", () => {
  it("takes a 7-8 digit UID", () => {
    expect(uidSchema.safeParse("1234567").success).toBe(true);
    expect(uidSchema.safeParse("12345678").success).toBe(true);
  });

  it("refuses a student ID and anything else", () => {
    for (const s of ["3031234567", "3031234", "123456", "12a4567", ""]) {
      expect(uidSchema.safeParse(s).success).toBe(false);
    }
  });
});

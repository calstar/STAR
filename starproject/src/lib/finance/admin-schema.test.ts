import { describe, expect, it } from "vitest";

import { accountInputSchema, incomeInputSchema, parseSignedMoney } from "@/lib/finance/admin-schema";

describe("parseSignedMoney", () => {
  it("reads an overdrawn balance", () => {
    expect(parseSignedMoney("-80")).toBe(-8000);
    expect(parseSignedMoney(" $1,234.56 ")).toBe(123456);
    expect(parseSignedMoney("--1")).toBeNull();
    expect(parseSignedMoney("")).toBeNull();
  });
});

describe("accountInputSchema", () => {
  it("takes a name and a balance", () => {
    expect(accountInputSchema.parse({ name: " Venmo ", balance: "250", note: "" })).toEqual({ name: "Venmo", balance: 25000 });
  });

  it("refuses a balance that isn't money", () => {
    const r = accountInputSchema.safeParse({ name: "Venmo", balance: "lots" });
    expect(r.success).toBe(false);
  });
});

describe("incomeInputSchema", () => {
  const ok = { schoolYear: 2026, source: "Sponsor", amount: "5,000", expectedOn: "", received: false };

  it("takes an amount and an optional date", () => {
    expect(incomeInputSchema.parse(ok)).toEqual({ schoolYear: 2026, source: "Sponsor", amount: 500000, received: false });
    expect(incomeInputSchema.parse({ ...ok, expectedOn: "2027-01-15" }).expectedOn).toBe("2027-01-15");
  });

  it("refuses nothing, negatives and a bad date", () => {
    expect(incomeInputSchema.safeParse({ ...ok, amount: "0" }).success).toBe(false);
    expect(incomeInputSchema.safeParse({ ...ok, amount: "-5" }).success).toBe(false);
    expect(incomeInputSchema.safeParse({ ...ok, expectedOn: "Jan 15" }).success).toBe(false);
  });
});

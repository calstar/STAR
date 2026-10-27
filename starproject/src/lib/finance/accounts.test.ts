import { describe, expect, it } from "vitest";

import { parseCallinkAccounts } from "@/lib/finance/accounts";

describe("parseCallinkAccounts", () => {
  it("reads CalLink's financeAccount as cents", () => {
    expect(
      parseCallinkAccounts([
        { balance: 7098.53, availableFunds: 0, externalAccountId: "", deleted: false, id: 94918, name: "SUMMARY-203828-Space Technologies and Rocketry" },
        { balance: 0.1 + 0.2, id: 94919, name: " 3-70-203828-00000-MISC-STAR " },
      ]),
    ).toEqual([
      { callinkAccountId: 94918, name: "SUMMARY-203828-Space Technologies and Rocketry", balanceCents: 709853, availableCents: 0, deleted: false },
      { callinkAccountId: 94919, name: "3-70-203828-00000-MISC-STAR", balanceCents: 30, availableCents: null, deleted: false },
    ]);
  });

  it("refuses anything it can't read", () => {
    expect(typeof parseCallinkAccounts([])).toBe("string");
    expect(typeof parseCallinkAccounts(null)).toBe("string");
    expect(typeof parseCallinkAccounts([{ id: "1", name: "x", balance: 1 }])).toBe("string");
    expect(typeof parseCallinkAccounts([{ id: 1, name: "x", balance: "7098.53" }])).toBe("string");
    expect(typeof parseCallinkAccounts([{ id: 1, name: "x", balance: 1e12 }])).toBe("string");
  });
});

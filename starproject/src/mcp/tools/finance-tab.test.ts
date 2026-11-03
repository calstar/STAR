import { describe, expect, it } from "vitest";

import { accountInputSchema } from "@/lib/finance/admin-schema";

import { centsText, check, dollars } from "./finance-tab";

describe("finance tab tool helpers", () => {
  it("writes dollars as the text the money fields parse", () => {
    expect(dollars(1234.5)).toBe("1234.50");
    expect(dollars(-80)).toBe("-80.00");
    expect(centsText(141109)).toBe("1411.09");
    expect(centsText(-8000)).toBe("-80.00");
  });

  it("round-trips a kept balance through the account schema unchanged", () => {
    for (const cents of [0, 5, 141109, -8000]) {
      const parsed = accountInputSchema.parse({ name: "Gift fund", balance: centsText(cents) });
      expect(parsed.balance, String(cents)).toBe(cents);
    }
  });

  it("passes ok and throws a refusal with its field errors", () => {
    expect(() => check({ ok: true })).not.toThrow();
    expect(() => check({ error: "Admins only." })).toThrow(/^Admins only\.$/);
    expect(() => check({ error: "Some fields need fixing.", fieldErrors: { amount: "Enter the amount" } })).toThrow(
      "Some fields need fixing. (amount: Enter the amount)",
    );
  });
});

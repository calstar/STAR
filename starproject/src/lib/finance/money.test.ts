import { describe, expect, it } from "vitest";

import { MAX_CENTS, centsToPlain, formatCents, parseMoney, sumCents } from "@/lib/finance/money";

describe("parseMoney", () => {
  it("reads the ways members type a total", () => {
    expect(parseMoney("505.51")).toBe(50551);
    expect(parseMoney("$505.51")).toBe(50551);
    expect(parseMoney("1,411.09")).toBe(141109);
    expect(parseMoney(" $12 ")).toBe(1200);
    expect(parseMoney("12.5")).toBe(1250);
  });

  it("returns null for anything that is not an amount", () => {
    for (const s of ["N/A", "bank statement", "£78.57", "", "1.234", "-5", null, undefined]) {
      expect(parseMoney(s)).toBeNull();
    }
  });

  it("refuses a total no receipt could have", () => {
    expect(parseMoney("1000000.00")).toBe(MAX_CENTS);
    expect(parseMoney("106963555")).toBeNull();
  });

  it("does not drift the way floats do", () => {
    // 0.1 + 0.2 style: 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(parseMoney("19.99")).toBe(1999);
    expect(sumCents([parseMoney("0.10"), parseMoney("0.20")])).toBe(30);
  });
});

describe("formatting", () => {
  it("formats cents for people and for CalLink", () => {
    expect(formatCents(141109)).toBe("$1,411.09");
    expect(formatCents(5)).toBe("$0.05");
    expect(centsToPlain(141109)).toBe("1411.09");
    expect(centsToPlain(100)).toBe("1.00");
  });

  it("sums only the amounts that parsed", () => {
    expect(sumCents([100, null, 235, undefined])).toBe(335);
  });
});

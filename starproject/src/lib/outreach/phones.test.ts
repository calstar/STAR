import { describe, expect, it } from "vitest";

import { formatPhone, normalizePhone, smsHref } from "./phones";

describe("normalizePhone", () => {
  it("reads the ways people type a US number", () => {
    for (const s of ["(650) 555-0199", "650.555.0199", "650-555-0199", "+1 650 555 0199", "1 (650) 555-0199", "6505550199 (cell)"]) {
      expect(normalizePhone(s), s).toBe("+16505550199");
    }
  });
  it("keeps an international number and drops an extension", () => {
    expect(normalizePhone("+82 10-1234-5678")).toBe("+821012345678");
    expect(normalizePhone("650-555-0199 x204")).toBe("+16505550199");
  });
  it("refuses what isn't a phone number", () => {
    for (const s of ["", "n/a", "555-1234", "ask his mom", "12345678901234567"]) expect(normalizePhone(s), s).toBeNull();
  });
});

describe("formatPhone / smsHref", () => {
  it("shows US numbers the usual way and builds an SMS link", () => {
    expect(formatPhone("+16505550199")).toBe("(650) 555-0199");
    expect(formatPhone("+821012345678")).toBe("+821012345678");
    expect(smsHref("+16505550199", "Hi & hello")).toBe("sms:+16505550199?&body=Hi%20%26%20hello");
  });
});

import { describe, expect, it } from "vitest";

import { canSeePii, isMine, redact, type DetailDto } from "@/lib/finance/access";

const r = { createdById: "u-filer", payeeEmail: "payee@berkeley.edu", submitterEmail: "sub@berkeley.edu" };
const member = (id: string, email: string, isAdmin = false) => ({ id, email, isAdmin });

describe("canSeePii", () => {
  it("shows PII to the payee, the submitter, the filer and admins", () => {
    expect(canSeePii(member("x", "PAYEE@berkeley.edu"), r)).toBe(true);
    expect(canSeePii(member("x", "sub@berkeley.edu"), r)).toBe(true);
    expect(canSeePii(member("u-filer", "other@berkeley.edu"), r)).toBe(true);
    expect(canSeePii(member("x", "admin@berkeley.edu", true), r)).toBe(true);
  });

  it("hides it from everyone else", () => {
    expect(canSeePii(member("x", "someone@berkeley.edu"), r)).toBe(false);
  });

  it("does not treat missing emails as a match", () => {
    const blank = { createdById: null, payeeEmail: null, submitterEmail: null };
    expect(isMine(member("x", ""), blank)).toBe(false);
  });
});

describe("redact", () => {
  const detail: DetailDto<{ subject: string }> = {
    subject: "Motor",
    pii: { street: "1 Main St", street2: null, city: "Berkeley", state: "CA", zip: "94704", phone: "5105550100", uid: "1234567" },
    items: [
      {
        position: 1, date: "2026-10-02", vendor: "Wildman", amountCents: 100, amountText: null, comment: null,
        type: null, location: null, invoice: null, receiptCount: 1,
        receipts: [{ id: "r1", fileName: "label.pdf", size: 10, url: "/api/finance/receipts/r1" }],
      },
    ],
  };

  it("removes the address, phone, UID and receipt links", () => {
    const out = redact(detail, false);
    expect(out.pii).toBeNull();
    expect(out.items[0].receipts).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/1 Main St|1234567|5105550100|label\.pdf/);
  });

  it("keeps what everyone sees", () => {
    const out = redact(detail, false);
    expect(out.subject).toBe("Motor");
    expect(out.items[0].vendor).toBe("Wildman");
    expect(out.items[0].receiptCount).toBe(1);
  });

  it("passes everything through when allowed", () => {
    expect(redact(detail, true)).toBe(detail);
  });
});

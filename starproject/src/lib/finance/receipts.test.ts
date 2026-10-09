import { describe, expect, it } from "vitest";

import { checkReceipt, MAX_RECEIPT_BYTES, safeFileName } from "@/lib/finance/receipts";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe("checkReceipt", () => {
  it("accepts real PDFs, PNGs and JPEGs", () => {
    expect(checkReceipt("r.pdf", 10, PDF)).toEqual({ ok: true, mime: "application/pdf" });
    expect(checkReceipt("r.PNG", 10, PNG)).toEqual({ ok: true, mime: "image/png" });
    expect(checkReceipt("r.jpeg", 10, JPG)).toEqual({ ok: true, mime: "image/jpeg" });
  });

  it("refuses files CalLink would refuse", () => {
    expect(checkReceipt("big.pdf", MAX_RECEIPT_BYTES + 1, PDF).ok).toBe(false);
    expect(checkReceipt("empty.pdf", 0, PDF).ok).toBe(false);
    expect(checkReceipt("doc.docx", 10, PDF).ok).toBe(false);
  });

  it("names the HEIC problem", () => {
    const r = checkReceipt("IMG_0001.HEIC", 10, JPG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HEIC/);
  });

  it("goes by the bytes, not the name", () => {
    expect(checkReceipt("fake.pdf", 10, PNG).ok).toBe(false);
  });
});

describe("safeFileName", () => {
  it("strips paths and odd characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('a"b;c.pdf')).toBe("a_b_c.pdf");
    expect(safeFileName("")).toBe("receipt");
  });
});

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { keyMatches, uploadFileName } from "@/lib/finance/receipt-upload";
import { checkReceipt } from "@/lib/finance/receipts";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const HTML = new TextEncoder().encode("<html><b");

describe("uploadFileName", () => {
  it("keeps a name that already has a receipt extension", () => {
    expect(uploadFileName("Home Depot.pdf", PDF)).toBe("Home Depot.pdf");
    expect(uploadFileName("photo.JPEG", JPG)).toBe("photo.JPEG");
  });

  it("adds the extension the bytes show when the name has none", () => {
    expect(uploadFileName(null, PDF)).toBe("receipt.pdf");
    expect(uploadFileName("scan", PNG)).toBe("scan.png");
    expect(uploadFileName("  ", JPG)).toBe("receipt.jpg");
  });

  it("cleans path parts and odd characters out of the name", () => {
    expect(uploadFileName("../../etc/passwd.pdf", PDF)).toBe("passwd.pdf");
  });

  it("leaves a file that isn't a receipt for checkReceipt to refuse", () => {
    const name = uploadFileName("page", HTML);
    expect(checkReceipt(name, 100, HTML)).toMatchObject({ ok: false });
    // A real receipt's name passes the check its bytes are held to.
    expect(checkReceipt(uploadFileName("scan", PDF), 100, PDF)).toEqual({ ok: true, mime: "application/pdf" });
  });

  it("does not let a receipt name pass bytes that aren't that type", () => {
    expect(checkReceipt(uploadFileName("fake.pdf", HTML), 100, HTML)).toMatchObject({ ok: false });
  });
});

describe("keyMatches", () => {
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");

  it("accepts the key whose hash was stored and nothing else", () => {
    expect(keyMatches("abc", hash("abc"))).toBe(true);
    expect(keyMatches("abd", hash("abc"))).toBe(false);
    expect(keyMatches("", hash("abc"))).toBe(false);
  });
});

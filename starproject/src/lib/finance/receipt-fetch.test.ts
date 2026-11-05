import { describe, expect, it } from "vitest";

import { isInlineMime, sniffMime } from "@/lib/finance/receipt-fetch";

const bytes = (s: string | number[]) => (typeof s === "string" ? new TextEncoder().encode(s) : new Uint8Array(s));

describe("sniffMime", () => {
  it("knows PDFs and images by their bytes", () => {
    expect(sniffMime(bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMime(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffMime(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  it("calls everything else a download, however it is named", () => {
    expect(sniffMime(bytes("<html><script>alert(1)</script>"))).toBe("application/octet-stream");
    expect(sniffMime(bytes("RIFF\0\0\0\0WAVEfmt "))).toBe("application/octet-stream");
    expect(sniffMime(bytes("PK\x03\x04"))).toBe("application/octet-stream"); // .docx
    expect(sniffMime(bytes(""))).toBe("application/octet-stream");
  });
});

describe("isInlineMime", () => {
  it("shows PDFs and images, downloads the rest", () => {
    expect(isInlineMime("application/pdf")).toBe(true);
    expect(isInlineMime("image/png")).toBe(true);
    expect(isInlineMime("application/octet-stream")).toBe(false);
    expect(isInlineMime("text/html")).toBe(false);
  });
});

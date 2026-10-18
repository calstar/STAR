import { describe, expect, it } from "vitest";

import { isManufacturingField, parseManufacturingValue } from "@/lib/manufacturing";

describe("parseManufacturingValue", () => {
  it("clears a field on blank input", () => {
    expect(parseManufacturingValue("partName", "   ")).toBeNull();
    expect(parseManufacturingValue("quantity", "")).toBeNull();
    expect(parseManufacturingValue("onshapeUrl", "")).toBeNull();
  });

  it("trims text and rejects overlong text", () => {
    expect(parseManufacturingValue("material", "  6061-T6 ")).toBe("6061-T6");
    expect(() => parseManufacturingValue("partName", "x".repeat(201))).toThrow();
  });

  it("takes whole positive quantities only", () => {
    expect(parseManufacturingValue("quantity", "12")).toBe(12);
    for (const bad of ["0", "-3", "2.5", "a few", "100001"])
      expect(() => parseManufacturingValue("quantity", bad)).toThrow();
  });

  it("takes only http(s) links", () => {
    const link = "https://cad.onshape.com/documents/abc/w/def/e/ghi";
    expect(parseManufacturingValue("onshapeUrl", link)).toBe(link);
    for (const bad of ["cad.onshape.com/documents/abc", "javascript:alert(1)", "ftp://x/y"])
      expect(() => parseManufacturingValue("drawingUrl", bad)).toThrow();
  });

  it("knows its fields", () => {
    expect(isManufacturingField("mfgReId")).toBe(true);
    expect(isManufacturingField("title")).toBe(false);
  });
});

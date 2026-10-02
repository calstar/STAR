import { describe, expect, it } from "vitest";

import { internalSecretOk } from "./internalAuth";

describe("internalSecretOk", () => {
  it("admits only the exact secret", () => {
    expect(internalSecretOk("s3cret-value", "s3cret-value")).toBe(true);
    expect(internalSecretOk("s3cret-valuX", "s3cret-value")).toBe(false);
    expect(internalSecretOk("s3cret", "s3cret-value")).toBe(false);
    expect(internalSecretOk(null, "s3cret-value")).toBe(false);
  });

  it("refuses everyone when no secret is configured", () => {
    expect(internalSecretOk("", undefined)).toBe(false);
    expect(internalSecretOk("", "")).toBe(false);
    expect(internalSecretOk("anything", undefined)).toBe(false);
  });
});

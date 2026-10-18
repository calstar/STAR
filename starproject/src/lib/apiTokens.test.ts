import { describe, expect, it } from "vitest";

import {
  PREFIX_SHOWN,
  TOKEN_PREFIX,
  displayPrefix,
  generateToken,
  hashToken,
  looksLikeToken,
  parseBearer,
} from "./apiTokens";

describe("api tokens", () => {
  it("mints distinct sp_ tokens of a fixed shape", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32 bytes base64url = 43 chars, plus the prefix.
    expect(a).toHaveLength(TOKEN_PREFIX.length + 43);
    expect(a).toMatch(/^sp_[A-Za-z0-9_-]+$/);
    expect(looksLikeToken(a)).toBe(true);
  });

  it("hashes deterministically and never stores the plaintext", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t.slice(3, 12));
    expect(displayPrefix(t)).toBe(t.slice(0, PREFIX_SHOWN));
  });

  it("parses only a well-formed bearer header", () => {
    expect(parseBearer("Bearer sp_abc")).toBe("sp_abc");
    expect(parseBearer("bearer sp_abc")).toBe("sp_abc");
    expect(parseBearer("Basic sp_abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it("rejects strings that are not our tokens before touching the DB", () => {
    expect(looksLikeToken("sp_short")).toBe(false);
    expect(looksLikeToken("gho_" + "x".repeat(40))).toBe(false);
    expect(looksLikeToken("")).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The token row lookup, faked: the scope check is what's under test, not Prisma.
const { findUnique, update } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { apiToken: { findUnique, update } } }));

import {
  PREFIX_SHOWN,
  TOKEN_PREFIX,
  authenticateBearer,
  authenticateToken,
  cleanScopes,
  displayPrefix,
  generateToken,
  hasScope,
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

describe("token scopes", () => {
  it("cleans a requested scope list, refusing empty or unknown", () => {
    expect(cleanScopes(["design", "starproject", "design"])).toEqual(["starproject", "design"]);
    expect(cleanScopes(["design"])).toEqual(["design"]);
    expect(cleanScopes([])).toBeNull();
    expect(cleanScopes(["design", "admin"])).toBeNull();
    expect(cleanScopes([1])).toBeNull();
  });

  it("reads stored scopes, tolerating a null column", () => {
    expect(hasScope(["starproject"], "starproject")).toBe(true);
    expect(hasScope(["starproject"], "design")).toBe(false);
    expect(hasScope(null, "starproject")).toBe(false);
  });
});

describe("authenticating a token for one server", () => {
  const token = generateToken();
  const row = (scopes: string[], revokedAt: Date | null = null) => ({
    id: "tok1",
    userId: "u1",
    tokenHash: hashToken(token),
    scopes,
    revokedAt,
    lastUsedAt: new Date(),
    user: { email: "a@berkeley.edu", name: "A" },
  });

  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it("admits a token on the server its scopes name", async () => {
    findUnique.mockResolvedValue(row(["starproject", "design"]));
    const auth = await authenticateToken(token, "design");
    expect(auth).toMatchObject({ ok: true, identity: { email: "a@berkeley.edu" }, tokenId: "tok1" });
  });

  it("refuses a design-only token on STARProject's own MCP", async () => {
    findUnique.mockResolvedValue(row(["design"]));
    expect(await authenticateBearer(`Bearer ${token}`, "starproject")).toEqual({ ok: false, reason: "scope" });
  });

  it("refuses a token minted before scopes on the design server", async () => {
    // The migration backfills ["starproject"]: old tokens open exactly what they did.
    findUnique.mockResolvedValue(row(["starproject"]));
    expect(await authenticateToken(token, "design")).toEqual({ ok: false, reason: "scope" });
    expect(update).not.toHaveBeenCalled();
  });

  it("still refuses a revoked token whatever its scopes", async () => {
    findUnique.mockResolvedValue(row(["starproject", "design"], new Date()));
    expect(await authenticateToken(token, "design")).toEqual({ ok: false, reason: "revoked" });
  });
});

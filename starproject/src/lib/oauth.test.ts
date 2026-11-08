import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The OAuth tables and token mint, faked: the protocol checks are what's under test.
const db = vi.hoisted(() => ({
  oAuthClient: { create: vi.fn(), findUnique: vi.fn() },
  oAuthCode: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  apiToken: { create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { hashToken } from "./apiTokens";
import {
  checkAuthorize,
  exchangeCode,
  issueCode,
  pkceMatches,
  redirectUriAllowed,
  registerClient,
  scopeFor,
} from "./oauth";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_BASE_URL = "https://project.starberkeley.org";
  delete process.env.DESIGN_MCP_RESOURCE;
  delete process.env.OAUTH_EXTRA_REDIRECT_URIS;
});

describe("redirect URIs", () => {
  it("allows claude.ai's callback and loopback, nothing else", () => {
    expect(redirectUriAllowed(CLAUDE)).toBe(true);
    expect(redirectUriAllowed("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed("http://localhost:6274/oauth/callback")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback/../evil")).toBe(false);
    expect(redirectUriAllowed("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed("https://localhost/callback")).toBe(false);
    expect(redirectUriAllowed("http://localhost.evil.example/cb")).toBe(false);
    expect(redirectUriAllowed("http://user@localhost:80/cb")).toBe(false);
    expect(redirectUriAllowed("not a url")).toBe(false);
  });

  it("takes extra exact URIs from the environment", () => {
    process.env.OAUTH_EXTRA_REDIRECT_URIS = "https://example.org/cb, https://other.org/cb";
    expect(redirectUriAllowed("https://other.org/cb")).toBe(true);
    expect(redirectUriAllowed("https://other.org/cb2")).toBe(false);
  });
});

describe("resource → scope", () => {
  it("maps each MCP server's URL to its scope", () => {
    expect(scopeFor("https://mcp.starberkeley.org/mcp", null)).toBe("design");
    expect(scopeFor("https://mcp.starberkeley.org/mcp/", null)).toBe("design");
    expect(scopeFor("https://project.starberkeley.org/api/mcp", null)).toBe("starproject");
    expect(scopeFor("https://mcp.starberkeley.org/other", "design")).toBeNull();
  });

  it("falls back to a scope naming exactly one server", () => {
    expect(scopeFor(undefined, "design")).toBe("design");
    expect(scopeFor(undefined, "starproject design")).toBeNull();
    expect(scopeFor(undefined, "admin")).toBeNull();
    expect(scopeFor(undefined, undefined)).toBeNull();
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B example", () => {
    expect(pkceMatches(VERIFIER, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(pkceMatches(VERIFIER, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN")).toBe(false);
    expect(pkceMatches("short", createHash("sha256").update("short").digest("base64url"))).toBe(false);
  });
});

describe("registration", () => {
  it("refuses a redirect URI off the allowlist without storing anything", async () => {
    const out = await registerClient({ redirect_uris: [CLAUDE, "https://evil.example/cb"] });
    expect(out).toMatchObject({ error: "invalid_redirect_uri" });
    expect(db.oAuthClient.create).not.toHaveBeenCalled();
    expect(await registerClient({})).toMatchObject({ error: "invalid_redirect_uri" });
    expect(await registerClient({ redirect_uris: [42] })).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("registers a public client", async () => {
    db.oAuthClient.create.mockResolvedValue({ id: "c1", name: "Claude", redirectUris: [CLAUDE], createdAt: new Date(0) });
    const out = await registerClient({ redirect_uris: [CLAUDE], client_name: "Claude" });
    expect(out).toMatchObject({ client_id: "c1", token_endpoint_auth_method: "none" });
  });
});

const CLIENT = { id: "c1", name: "Claude", redirectUris: [CLAUDE] };
const GOOD = {
  response_type: "code",
  client_id: "c1",
  redirect_uri: CLAUDE,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "xyz",
  resource: "https://mcp.starberkeley.org/mcp",
};

describe("authorize", () => {
  it("never redirects to an unverified client or URI", async () => {
    db.oAuthClient.findUnique.mockResolvedValue(null);
    expect(await checkAuthorize(GOOD)).toHaveProperty("fatal");
    db.oAuthClient.findUnique.mockResolvedValue(CLIENT);
    expect(await checkAuthorize({ ...GOOD, redirect_uri: "http://localhost:1/cb" })).toHaveProperty("fatal");
  });

  it("sends protocol errors back to the verified redirect URI with state", async () => {
    db.oAuthClient.findUnique.mockResolvedValue(CLIENT);
    const out = await checkAuthorize({ ...GOOD, code_challenge_method: "plain" });
    expect(out).toHaveProperty("redirect");
    const u = new URL((out as { redirect: string }).redirect);
    expect(u.origin + u.pathname).toBe(CLAUDE);
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("state")).toBe("xyz");
    const target = await checkAuthorize({ ...GOOD, resource: "https://elsewhere.example/mcp" });
    expect(new URL((target as { redirect: string }).redirect).searchParams.get("error")).toBe("invalid_target");
  });

  it("accepts a good request and issues a hashed, short-lived code", async () => {
    db.oAuthClient.findUnique.mockResolvedValue(CLIENT);
    const out = await checkAuthorize(GOOD);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.req.scope).toBe("design");
    const back = new URL(await issueCode(out.req, "u1"));
    const code = back.searchParams.get("code")!;
    expect(back.searchParams.get("state")).toBe("xyz");
    const stored = db.oAuthCode.create.mock.calls[0][0].data;
    expect(stored.codeHash).toBe(hashToken(code));
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.scopes).toEqual(["design"]);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("token exchange", () => {
  const row = (over: object = {}) => ({
    id: "k1",
    clientId: "c1",
    client: CLIENT,
    userId: "u1",
    redirectUri: CLAUDE,
    codeChallenge: CHALLENGE,
    scopes: ["design"],
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    tokenId: null,
    ...over,
  });
  const exchange = (over: object = {}) =>
    exchangeCode({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: CLAUDE,
      client_id: "c1",
      code_verifier: VERIFIER,
      ...over,
    });

  beforeEach(() => {
    db.oAuthCode.updateMany.mockResolvedValue({ count: 1 });
    db.apiToken.create.mockResolvedValue({ id: "t1" });
  });

  it("mints a design-scoped sp_ token for the code's owner", async () => {
    db.oAuthCode.findUnique.mockResolvedValue(row());
    const out = await exchange();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.access_token.startsWith("sp_")).toBe(true);
    expect(out.body.scope).toBe("design");
    expect(db.apiToken.create.mock.calls[0][0].data).toMatchObject({ userId: "u1", scopes: ["design"] });
    expect(db.oAuthCode.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { tokenId: "t1" } });
  });

  it("refuses a wrong verifier, client, redirect, or an expired code, and mints nothing", async () => {
    db.oAuthCode.findUnique.mockResolvedValue(row());
    expect((await exchange({ code_verifier: VERIFIER.replace("d", "e") })).ok).toBe(false);
    expect((await exchange({ client_id: "c2" })).ok).toBe(false);
    expect((await exchange({ redirect_uri: "http://localhost:1/cb" })).ok).toBe(false);
    expect((await exchange({ resource: "https://project.starberkeley.org/api/mcp" })).ok).toBe(false);
    db.oAuthCode.findUnique.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }));
    expect((await exchange()).ok).toBe(false);
    expect(db.apiToken.create).not.toHaveBeenCalled();
    expect(db.oAuthCode.updateMany).not.toHaveBeenCalled();
  });

  it("revokes the first token when a code is used twice", async () => {
    db.oAuthCode.findUnique.mockResolvedValue(row({ usedAt: new Date(), tokenId: "t1" }));
    const out = await exchange();
    expect(out).toMatchObject({ ok: false, body: { error: "invalid_grant" } });
    expect(db.apiToken.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.apiToken.create).not.toHaveBeenCalled();
  });

  it("loses a race for the code without minting", async () => {
    db.oAuthCode.findUnique.mockResolvedValue(row());
    db.oAuthCode.updateMany.mockResolvedValue({ count: 0 });
    expect((await exchange()).ok).toBe(false);
    expect(db.apiToken.create).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";

import { identityFromHeaders } from "./auth";

// The header identity seam, as pure logic: which headers are trusted, when the
// dev fallback applies, and what the X-Auth-Gate secret changes.

const from = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const caddy = { "x-auth-email": "ada@berkeley.edu", "x-auth-user": "Ada L" };

describe("identityFromHeaders", () => {
  it("reads Caddy's headers", () => {
    expect(identityFromHeaders(from(caddy), { NODE_ENV: "production" })).toEqual({ email: "ada@berkeley.edu", name: "Ada L" });
  });

  it("falls back to DEV_AUTH_* only outside production", () => {
    const env = { DEV_AUTH_EMAIL: "dev@berkeley.edu", DEV_AUTH_NAME: "Dev" };
    expect(identityFromHeaders(from({}), { ...env, NODE_ENV: "development" })).toEqual({ email: "dev@berkeley.edu", name: "Dev" });
    expect(identityFromHeaders(from({}), { ...env, NODE_ENV: "production" })).toBeNull();
    expect(identityFromHeaders(from({}), { NODE_ENV: "development" })).toBeNull();
  });

  it("with AUTH_GATE_SECRET set, trusts the headers only alongside the matching gate", () => {
    const env = { NODE_ENV: "production", AUTH_GATE_SECRET: "gate-gate-gate-gate" };
    expect(identityFromHeaders(from(caddy), env)).toBeNull();
    expect(identityFromHeaders(from({ ...caddy, "x-auth-gate": "wrong" }), env)).toBeNull();
    expect(identityFromHeaders(from({ ...caddy, "x-auth-gate": "gate-gate-gate-gate" }), env)).toEqual({
      email: "ada@berkeley.edu",
      name: "Ada L",
    });
  });

  it("an unset or empty gate secret changes nothing", () => {
    expect(identityFromHeaders(from(caddy), { NODE_ENV: "production", AUTH_GATE_SECRET: "" })).toEqual({
      email: "ada@berkeley.edu",
      name: "Ada L",
    });
  });
});

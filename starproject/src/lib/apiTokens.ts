import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { CurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Personal access tokens for the MCP endpoint. A token is `sp_` + 32 random
// bytes (base64url); only its SHA-256 is stored. scripts/mcp-token.mjs mints the
// same format straight into the DB for local testing -- keep the two in step.

export const TOKEN_PREFIX = "sp_";
export const TOKEN_BYTES = 32;
export const PREFIX_SHOWN = 8;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function displayPrefix(token: string): string {
  return token.slice(0, PREFIX_SHOWN);
}

/** The bearer token in an Authorization header, or null if there isn't one. */
export function parseBearer(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return m ? m[1] : null;
}

export function looksLikeToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length + 16;
}

// Which MCP servers a token opens. "starproject" is this app's /api/mcp;
// "design" is the design-tools MCP on the apps box (design-mcp/), which asks
// /api/mcp/verify whether a token carries it. A token gets its scopes at mint
// time and keeps them; there is no widening a live token.
export const TOKEN_SCOPES = ["starproject", "design"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && (TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes asked for, de-duplicated in TOKEN_SCOPES order. Null when the list
 * is empty or names a scope that doesn't exist: a typo must refuse the mint,
 * not quietly mint a token that opens less (or nothing) than was asked for.
 */
export function cleanScopes(requested: readonly unknown[]): TokenScope[] | null {
  if (requested.length === 0 || !requested.every(isTokenScope)) return null;
  return TOKEN_SCOPES.filter((s) => requested.includes(s));
}

/** True when a token's stored scopes include `scope`. Unknown stored values are ignored. */
export function hasScope(stored: readonly string[] | null | undefined, scope: TokenScope): boolean {
  return (stored ?? []).includes(scope);
}

export type TokenAuth =
  | { ok: true; identity: CurrentUser; userId: string; tokenId: string }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" | "scope" };

// How often lastUsedAt is refreshed; one write per minute per token at most.
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Resolve an Authorization header to the user who owns the token, for the MCP
 * server named by `scope`. A live token without that scope is refused
 * ("scope") and does not count as a use.
 */
export async function authenticateBearer(
  authorization: string | null | undefined,
  scope: TokenScope,
): Promise<TokenAuth> {
  const token = parseBearer(authorization);
  if (!token) return { ok: false, reason: "missing" };
  return authenticateToken(token, scope);
}

/** The same check for a token handed over bare (the /api/mcp/verify body). */
export async function authenticateToken(token: string, scope: TokenScope): Promise<TokenAuth> {
  if (!looksLikeToken(token)) return { ok: false, reason: "malformed" };

  const hash = hashToken(token);
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });
  // The unique index did the lookup; compare again in constant time anyway so
  // the row's hash is what admitted the caller, not the query.
  if (!row || !timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(hash, "hex"))) {
    return { ok: false, reason: "unknown" };
  }
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (!hasScope(row.scopes, scope)) return { ok: false, reason: "scope" };

  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } });
  }
  return {
    ok: true,
    // An empty name is "unknown"; getCurrentDbUser leaves the stored name alone
    // rather than overwriting it with a placeholder.
    identity: { email: row.user.email, name: row.user.name ?? "" },
    userId: row.userId,
    tokenId: row.id,
  };
}

export type ApiTokenView = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const VIEW = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

/** A user's tokens, newest first, revoked ones included so the list explains itself. */
export async function listTokens(userId: string): Promise<ApiTokenView[]> {
  return prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: VIEW,
  });
}

/** Mint a token for a user. The plaintext is returned once and never stored. */
export async function mintToken(
  userId: string,
  name: string,
  scopes: readonly TokenScope[],
): Promise<{ token: string; view: ApiTokenView }> {
  if (scopes.length === 0) throw new Error("A token needs at least one scope");
  const token = generateToken();
  const view = await prisma.apiToken.create({
    data: { userId, name, scopes: [...scopes], tokenHash: hashToken(token), prefix: displayPrefix(token) },
    select: VIEW,
  });
  return { token, view };
}

/** Revoke one of the user's own tokens. Returns false if it isn't theirs. */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const r = await prisma.apiToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return r.count === 1;
}

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

export type TokenAuth =
  | { ok: true; identity: CurrentUser; userId: string; tokenId: string }
  | { ok: false; reason: "missing" | "malformed" | "unknown" | "revoked" };

// How often lastUsedAt is refreshed; one write per minute per token at most.
const TOUCH_INTERVAL_MS = 60_000;

/** Resolve an Authorization header to the user who owns the token. */
export async function authenticateBearer(authorization: string | null | undefined): Promise<TokenAuth> {
  const token = parseBearer(authorization);
  if (!token) return { ok: false, reason: "missing" };
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
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

/** A user's tokens, newest first, revoked ones included so the list explains itself. */
export async function listTokens(userId: string): Promise<ApiTokenView[]> {
  return prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
}

/** Mint a token for a user. The plaintext is returned once and never stored. */
export async function mintToken(userId: string, name: string): Promise<{ token: string; view: ApiTokenView }> {
  const token = generateToken();
  const view = await prisma.apiToken.create({
    data: { userId, name, tokenHash: hashToken(token), prefix: displayPrefix(token) },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
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

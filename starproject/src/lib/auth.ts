import { AsyncLocalStorage } from "node:async_hooks";

import { headers } from "next/headers";

export type CurrentUser = { email: string; name: string };

// An identity set programmatically for the duration of one async call tree.
// The MCP endpoint (src/app/api/mcp/route.ts) authenticates a bearer token and
// runs the request inside `runAsIdentity`, so every server action it calls sees
// the token's owner exactly as if Caddy had injected the headers.
const injected = new AsyncLocalStorage<CurrentUser>();

export function runAsIdentity<T>(user: CurrentUser, fn: () => Promise<T>): Promise<T> {
  return injected.run(user, fn);
}

/**
 * The single identity seam for the whole app.
 *
 * Provider A (our deployment): Caddy's forward_auth gate validates the session
 * cookie and injects `X-Auth-Email` / `X-Auth-User` upstream, so we just read
 * those request headers — no JWT work here.
 *
 * Provider B: a bearer token on the MCP endpoint, resolved to a user and set
 * with `runAsIdentity` (checked first, so a token can never be overridden by a
 * header the client sent).
 *
 * Dev has no Caddy, so we fall back to DEV_AUTH_EMAIL / DEV_AUTH_NAME.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const fromToken = injected.getStore();
  if (fromToken) return fromToken;

  const h = await headers();
  // The DEV_AUTH_* fallback is for a machine with no Caddy. A production build
  // never honours it: a stray variable on the server must not become an
  // identity for every request that arrives with no header.
  const dev = process.env.NODE_ENV !== "production";
  const email = h.get("x-auth-email") ?? (dev ? process.env.DEV_AUTH_EMAIL : undefined) ?? null;
  const name =
    h.get("x-auth-user") ?? (dev ? process.env.DEV_AUTH_NAME : undefined) ?? "Dev User";

  if (email) return { email, name };

  throw new Error(
    "Unauthorized: no X-Auth-Email header (Caddy) and no DEV_AUTH_EMAIL fallback",
  );
}

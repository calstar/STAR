import { AsyncLocalStorage } from "node:async_hooks";

import { headers } from "next/headers";

import { internalSecretOk } from "@/lib/internalAuth";

export type CurrentUser = { email: string; name: string };

// An identity set programmatically for the duration of one async call tree.
// The MCP endpoint (src/app/api/mcp/route.ts) authenticates a bearer token and
// runs the request inside `runAsIdentity`, so every server action it calls sees
// the token's owner exactly as if Caddy had injected the headers.
const injected = new AsyncLocalStorage<CurrentUser>();

export function runAsIdentity<T>(user: CurrentUser, fn: () => Promise<T>): Promise<T> {
  return injected.run(user, fn);
}

type AuthEnv = {
  NODE_ENV?: string;
  DEV_AUTH_EMAIL?: string;
  DEV_AUTH_NAME?: string;
  AUTH_GATE_SECRET?: string;
};

/**
 * The identity in the request headers, or null when there is none to trust.
 *
 * With AUTH_GATE_SECRET set, X-Auth-Email counts only when the request also
 * carries X-Auth-Gate equal to it. Caddy adds that header after forward_auth
 * passes (deploy/ec2/caddy/Caddyfile) and nothing else knows the value, so a
 * container that reaches starproject:3000 directly on the compose network cannot
 * name a user. Unset (the default) trusts the headers as before.
 *
 * The DEV_AUTH_* fallback is for a machine with no Caddy. A production build
 * never honours it: a stray variable on the server must not become an identity
 * for every request that arrives with no header.
 */
export function identityFromHeaders(get: (name: string) => string | null, env: AuthEnv): CurrentUser | null {
  const gate = env.AUTH_GATE_SECRET;
  const trusted = !gate || internalSecretOk(get("x-auth-gate"), gate);
  const dev = env.NODE_ENV !== "production";
  const email = (trusted ? get("x-auth-email") : null) ?? (dev ? env.DEV_AUTH_EMAIL : undefined) ?? null;
  if (!email) return null;
  const name = (trusted ? get("x-auth-user") : null) ?? (dev ? env.DEV_AUTH_NAME : undefined) ?? "Dev User";
  return { email, name };
}

/**
 * The single identity seam for the whole app.
 *
 * Provider A (our deployment): Caddy's forward_auth gate validates the session
 * cookie and injects `X-Auth-Email` / `X-Auth-User` upstream, so we just read
 * those request headers — no JWT work here (see identityFromHeaders for the
 * optional X-Auth-Gate check).
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
  const user = identityFromHeaders((name) => h.get(name), process.env);
  if (user) return user;

  throw new Error(
    "Unauthorized: no X-Auth-Email header (Caddy) and no DEV_AUTH_EMAIL fallback",
  );
}

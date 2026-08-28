import { headers } from "next/headers";

export type CurrentUser = { email: string; name: string };

/**
 * The single identity seam for the whole app.
 *
 * Provider A (our deployment): Caddy's forward_auth gate validates the session
 * cookie and injects `X-Auth-Email` / `X-Auth-User` upstream, so we just read
 * those request headers — no JWT work here.
 *
 * Dev has no Caddy, so we fall back to DEV_AUTH_EMAIL / DEV_AUTH_NAME.
 *
 * Provider B (Phase 7, for other teams): an Auth.js (Google) session check
 * slots in right here behind the same return type.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const h = await headers();
  const email = h.get("x-auth-email") ?? process.env.DEV_AUTH_EMAIL ?? null;
  const name =
    h.get("x-auth-user") ?? process.env.DEV_AUTH_NAME ?? "Dev User";

  if (email) return { email, name };

  throw new Error(
    "Unauthorized: no X-Auth-Email header (Caddy) and no DEV_AUTH_EMAIL fallback",
  );
}

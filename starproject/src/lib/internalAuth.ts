import { timingSafeEqual } from "node:crypto";

// Gate for /api/internal/*: machine-to-machine reads from sibling services on the
// EC2 compose network (today, the server-analytics hub). Those calls bypass
// Caddy's cookie gate, so the route checks a shared secret itself.
//
// Unlike the cron routes, an unset secret refuses rather than admits: these
// routes hand out data, and "not configured" must not mean "open".
export function internalSecretOk(given: string | null, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

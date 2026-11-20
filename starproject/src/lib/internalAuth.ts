import { timingSafeEqual } from "node:crypto";

// Gate for /api/internal/* and /api/cron/*: machine-to-machine calls from sibling
// services on the EC2 compose network (the server-analytics hub, the cron
// sidecar). Those calls bypass Caddy's cookie gate, so the route checks a shared
// secret itself.
//
// An unset secret refuses rather than admits: these routes hand out data or send
// email to the whole team, and "not configured" must not mean "open".
export function internalSecretOk(given: string | null, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

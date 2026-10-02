import { createHash, timingSafeEqual } from "node:crypto";

// callink-worker calls /api/worker/* with `Authorization: Bearer <WORKER_TOKEN>`.
// This fails closed: with no token configured (or a short one) nothing gets in,
// unlike the cron routes, which skip their check when CRON_SECRET is unset.

export const MIN_TOKEN_LENGTH = 32;

export type WorkerAuth = "ok" | "unauthorized" | "misconfigured";

export function checkWorkerToken(authorization: string | null, secret: string | undefined): WorkerAuth {
  if (!secret || secret.length < MIN_TOKEN_LENGTH) return "misconfigured";
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  if (!m) return "unauthorized";
  // Hash both sides so the comparison is constant-time whatever their lengths.
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}

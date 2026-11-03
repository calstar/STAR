import { NextResponse } from "next/server";

import { heartbeat } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/** The worker says whether its CalLink session is alive; admins see it on /reimbursements. */
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ session?: string; sessionExpiresAt?: string | null; lastScrapeAt?: string | null; note?: string | null }>(req);
  if (body?.session !== "ok" && body?.session !== "expired") {
    return NextResponse.json({ error: 'session must be "ok" or "expired"' }, { status: 400 });
  }
  if (body.sessionExpiresAt != null && Number.isNaN(new Date(body.sessionExpiresAt).getTime())) {
    return NextResponse.json({ error: "sessionExpiresAt must be a date" }, { status: 400 });
  }
  return NextResponse.json(
    await heartbeat({ session: body.session, sessionExpiresAt: body.sessionExpiresAt, lastScrapeAt: body.lastScrapeAt, note: body.note }),
  );
}

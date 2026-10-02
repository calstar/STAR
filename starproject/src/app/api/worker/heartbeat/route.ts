import { NextResponse } from "next/server";

import { heartbeat } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/** The worker says whether its CalLink session is alive; admins see it on /finance. */
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ session?: string; lastScrapeAt?: string | null; note?: string | null }>(req);
  if (body?.session !== "ok" && body?.session !== "expired") {
    return NextResponse.json({ error: 'session must be "ok" or "expired"' }, { status: 400 });
  }
  return NextResponse.json(await heartbeat({ session: body.session, lastScrapeAt: body.lastScrapeAt, note: body.note }));
}

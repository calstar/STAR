import { NextResponse } from "next/server";

import { reportLogin, takeLoginRequest } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/** The worker polls this; `login: true` means an admin pressed "Sign in to CalLink". */
export async function GET(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  return NextResponse.json({ login: await takeLoginRequest() });
}

/** Progress of the sign-in the worker took: waiting_duo, then ok or failed. */
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ state?: string; note?: string | null }>(req);
  if (body?.state !== "waiting_duo" && body?.state !== "ok" && body?.state !== "failed") {
    return NextResponse.json({ error: 'state must be "waiting_duo", "ok" or "failed"' }, { status: 400 });
  }
  return NextResponse.json(await reportLogin(body.state, typeof body.note === "string" ? body.note : null));
}

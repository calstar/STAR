import { NextResponse } from "next/server";

import { runEmailBatch } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Machine-triggered every 15 min by the starproject-cron sidecar. Flushes the
// assignment email queue as one email per recipient. Secret-gated.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runEmailBatch());
}

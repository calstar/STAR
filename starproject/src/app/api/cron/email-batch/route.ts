import { NextResponse } from "next/server";

import { internalSecretOk } from "@/lib/internalAuth";
import { runEmailBatch } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Machine-triggered every 15 min by the starproject-cron sidecar. Flushes the
// assignment email queue as one email per recipient. Secret-gated and
// fail-closed: no CRON_SECRET means nobody can trigger it (internalSecretOk).
export async function POST(req: Request) {
  if (!internalSecretOk(req.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runEmailBatch());
}

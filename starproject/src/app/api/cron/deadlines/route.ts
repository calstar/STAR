import { NextResponse } from "next/server";

import { internalSecretOk } from "@/lib/internalAuth";
import { runDeadlineScan } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Machine-triggered (the starproject-cron sidecar), not part of the authed UI.
// The internal call bypasses Caddy, so this route gates itself on CRON_SECRET,
// and fails closed: with no secret configured nobody can trigger it
// (internalSecretOk), since it emails the whole team.
export async function POST(req: Request) {
  if (!internalSecretOk(req.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDeadlineScan();
  return NextResponse.json(result);
}

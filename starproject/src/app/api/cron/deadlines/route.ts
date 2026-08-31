import { NextResponse } from "next/server";

import { runDeadlineScan } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// Machine-triggered (the starproject-cron sidecar), not part of the authed UI.
// The internal call bypasses Caddy, so this route gates itself on CRON_SECRET.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDeadlineScan();
  return NextResponse.json(result);
}

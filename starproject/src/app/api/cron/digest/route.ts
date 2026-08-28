import { NextResponse } from "next/server";

import { runDigest } from "@/lib/digest";

export const dynamic = "force-dynamic";

// Nightly, machine-triggered by the starproject-cron sidecar. Secret-gated.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runDigest());
}

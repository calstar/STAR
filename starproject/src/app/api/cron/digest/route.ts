import { NextResponse } from "next/server";

import { runDigest } from "@/lib/digest";
import { internalSecretOk } from "@/lib/internalAuth";

export const dynamic = "force-dynamic";

// Nightly, machine-triggered by the starproject-cron sidecar. Secret-gated and
// fail-closed: no CRON_SECRET means nobody can trigger it (internalSecretOk).
export async function POST(req: Request) {
  if (!internalSecretOk(req.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runDigest());
}

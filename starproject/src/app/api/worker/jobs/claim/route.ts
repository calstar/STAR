import { NextResponse } from "next/server";

import { claimJob } from "@/lib/finance/worker";
import { requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

// The worker asks for its next job: a reconcile (an expired lease to check on
// CalLink), a request to file, or nothing (204).
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const job = await claimJob();
  if (job.kind === "none") return new NextResponse(null, { status: 204 });
  return NextResponse.json(job);
}

import { NextResponse } from "next/server";

import { release } from "@/lib/finance/worker";
import { requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/** A dry run gives its job back to the queue. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const { status, body } = await release((await params).id);
  return NextResponse.json(body, { status });
}

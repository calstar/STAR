import { NextResponse } from "next/server";

import { finish, type JobResult } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

function valid(b: unknown): b is JobResult {
  if (!b || typeof b !== "object") return false;
  const r = b as Record<string, unknown>;
  if (r.ok === true) {
    return (r.callinkId == null || Number.isInteger(r.callinkId)) && (r.callinkRequestNumber == null || typeof r.callinkRequestNumber === "string");
  }
  return r.ok === false && (r.filed === false || r.filed === "unknown") && typeof r.error === "string";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<unknown>(req);
  if (!valid(body)) return NextResponse.json({ error: "expected {ok:true, callinkId?} or {ok:false, filed:false|'unknown', error}" }, { status: 400 });
  const { status, body: out } = await finish((await params).id, body);
  return NextResponse.json(out, { status });
}

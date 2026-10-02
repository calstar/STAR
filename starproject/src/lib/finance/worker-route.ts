import { NextResponse } from "next/server";

import { checkWorkerToken } from "@/lib/finance/worker-auth";

/** null when the caller is callink-worker; otherwise the response to send. */
export function requireWorker(req: Request): NextResponse | null {
  const auth = checkWorkerToken(req.headers.get("authorization"), process.env.WORKER_TOKEN);
  if (auth === "ok") return null;
  if (auth === "misconfigured") return NextResponse.json({ error: "worker API not configured" }, { status: 503 });
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function jsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

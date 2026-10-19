import { NextResponse } from "next/server";

import { parseCallinkAccounts } from "@/lib/finance/accounts";
import { recordCallinkAccounts } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

/** The worker reports CalLink's account balances, as of when it read them; admins see them on /finance. */
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ accounts?: unknown; asOf?: string }>(req);
  const accounts = parseCallinkAccounts(body?.accounts);
  if (typeof accounts === "string") return NextResponse.json({ error: accounts }, { status: 400 });
  const asOf = new Date(body?.asOf ?? "");
  if (Number.isNaN(asOf.getTime()) || asOf.getTime() > Date.now() + 5 * 60_000) {
    return NextResponse.json({ error: "asOf must be the time the balances were read" }, { status: 400 });
  }
  return NextResponse.json(await recordCallinkAccounts(accounts, asOf));
}

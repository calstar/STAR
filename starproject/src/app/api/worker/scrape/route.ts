import { NextResponse } from "next/server";

import type { ScrapedRecord } from "@/lib/finance/callink-import";
import { MAX_SCRAPE_BATCH, importScrape } from "@/lib/finance/worker";
import { jsonBody, requireWorker } from "@/lib/finance/worker-route";

export const dynamic = "force-dynamic";

// The worker pushes its CalLink scrape in batches. The last batch of a full scrape
// carries `listedIds`, every id CalLink lists, so deletions on CalLink show here.
export async function POST(req: Request) {
  const denied = requireWorker(req);
  if (denied) return denied;
  const body = await jsonBody<{ records?: ScrapedRecord[]; listedIds?: number[] }>(req);
  const records = body?.records ?? [];
  if (!Array.isArray(records) || records.length > MAX_SCRAPE_BATCH) {
    return NextResponse.json({ error: `send up to ${MAX_SCRAPE_BATCH} records per call` }, { status: 400 });
  }
  const listedIds = body?.listedIds;
  if (listedIds !== undefined && (!Array.isArray(listedIds) || !listedIds.every(Number.isInteger) || listedIds.length === 0)) {
    return NextResponse.json({ error: "listedIds must be a non-empty list of CalLink ids" }, { status: 400 });
  }
  return NextResponse.json(await importScrape(records, listedIds));
}

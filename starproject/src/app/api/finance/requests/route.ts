import { NextResponse } from "next/server";

import { fileReimbursement } from "@/lib/finance/file";
import { MAX_RECEIPT_BYTES } from "@/lib/finance/receipts";
import { MAX_ITEMS } from "@/lib/finance/schema";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// A member files a reimbursement: the form's JSON in `payload` plus one receipt
// per item as `receipt-<index>`. The work is `fileReimbursement`
// (src/lib/finance/file.ts), shared with the MCP tool; this route owns the
// transport: the body-size guard, the multipart parse, and the JSON the form
// reads. A route rather than a server action so a failed submit keeps the form
// (and its chosen files) and the 1 MB action body limit doesn't apply.

const MAX_BODY = MAX_ITEMS * MAX_RECEIPT_BYTES + 512 * 1024;

const fail = (error: string, fieldErrors?: Record<string, string>, status = 400) =>
  NextResponse.json({ error, fieldErrors }, { status });

export async function POST(req: Request) {
  const user = await getCurrentDbUser();
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return fail("That's too much to upload at once: each receipt must be under 4 MB.", undefined, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("The upload didn't arrive in one piece; try again.");
  }

  const result = await fileReimbursement(user, form);
  if ("error" in result) return fail(result.error, result.fieldErrors, result.status);
  return NextResponse.json({ number: result.number });
}

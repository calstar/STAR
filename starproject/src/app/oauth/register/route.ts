import { NextResponse } from "next/server";

import { registerClient } from "@/lib/oauth";

// Dynamic client registration (RFC 7591). Public: claude.ai registers itself
// here before sending anyone to /oauth/authorize. Only allowlisted redirect URIs
// are accepted (src/lib/oauth.ts), so a registration grants nothing by itself.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "Send JSON client metadata." },
      { status: 400, headers: HEADERS },
    );
  }
  const out = await registerClient(body);
  return NextResponse.json(out, { status: "error" in out ? 400 : 201, headers: HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" },
  });
}

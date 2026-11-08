import { NextResponse } from "next/server";

import { protectedResourceMetadata } from "@/lib/oauth";

// RFC 9728 metadata for this app's MCP endpoint, at both the bare path and the
// path-suffixed one (/.well-known/oauth-protected-resource/api/mcp) that
// /api/mcp's 401 points to. It names this app as the authorization server.

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

export function GET(): Response {
  return NextResponse.json(protectedResourceMetadata(), { headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

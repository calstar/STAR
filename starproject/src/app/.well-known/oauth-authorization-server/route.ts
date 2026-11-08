import { NextResponse } from "next/server";

import { authorizationServerMetadata } from "@/lib/oauth";

// RFC 8414 metadata: where an MCP client finds /oauth/{authorize,token,register}.
// Public (deploy/ec2/caddy/Caddyfile). See src/lib/oauth.ts.

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

export function GET(): Response {
  return NextResponse.json(authorizationServerMetadata(), { headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
}

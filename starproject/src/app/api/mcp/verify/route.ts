import { NextResponse } from "next/server";

import { authenticateToken, isTokenScope } from "@/lib/apiTokens";
import { internalSecretOk } from "@/lib/internalAuth";

// Token check for the design-tools MCP server, which runs on the apps box
// (design-mcp/) and holds no tokens of its own: people mint one token here, with
// the "design" scope, and that server asks this route who it belongs to.
//
// It sits under /api/mcp because that prefix already skips the cookie gate on
// the EC2 Caddy and has X-Auth-* stripped (deploy/ec2/caddy/Caddyfile) -- the
// apps box reaches it over the public internet, not a compose network. So the
// caller proves itself with DESIGN_MCP_VERIFY_SECRET, and an unset secret
// refuses everyone (internalSecretOk): "not configured" must not mean "open".
//
//   POST /api/mcp/verify   X-Internal-Secret: <secret>
//   { "token": "sp_…", "scope": "design" }
//   200 { email, name, tokenId }      401 { error: "unauthorized", reason }
//
// A valid call counts as a use of the token (lastUsedAt), like a call to /api/mcp.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req.headers.get("x-internal-secret"), process.env.DESIGN_MCP_VERIFY_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", hint: "Send JSON {token, scope}." }, { status: 400, headers: NO_STORE });
  }
  const { token, scope } = (body ?? {}) as { token?: unknown; scope?: unknown };
  if (typeof token !== "string" || !isTokenScope(scope)) {
    return NextResponse.json({ error: "bad_request", hint: "Send JSON {token, scope}." }, { status: 400, headers: NO_STORE });
  }
  const auth = await authenticateToken(token, scope);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json(
    { email: auth.identity.email, name: auth.identity.name, tokenId: auth.tokenId },
    { headers: NO_STORE },
  );
}

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";

import { authenticateBearer } from "@/lib/apiTokens";
import { runAsIdentity } from "@/lib/auth";
import { issuer } from "@/lib/oauth";
import { createStarProjectServer } from "@/mcp/server";

// The MCP endpoint. Streamable HTTP, stateless: each POST gets its own
// server + transport and is answered as JSON; GET and DELETE are 405. Identity is a personal access
// token (Settings → API tokens) in `Authorization: Bearer sp_…`; Caddy routes
// /api/mcp* around forward_auth and strips X-Auth-* so the token is the only
// identity this path can carry (deploy/ec2/caddy/Caddyfile).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// resource_metadata (RFC 9728) is how an OAuth client such as a claude.ai
// connector finds this app's authorization server (src/lib/oauth.ts).
function unauthorized(reason: string) {
  const challenge = `Bearer realm="starproject-mcp", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/api/mcp"`;
  return NextResponse.json(
    { error: "unauthorized", reason, hint: "Send `Authorization: Bearer <token>`; mint one under Settings → API tokens." },
    { status: 401, headers: { "WWW-Authenticate": challenge } },
  );
}

async function handle(req: Request): Promise<Response> {
  // Only a token minted with the "starproject" scope opens this server; a
  // design-tools-only token is refused here (src/lib/apiTokens.ts).
  const auth = await authenticateBearer(req.headers.get("authorization"), "starproject");
  if (!auth.ok) return unauthorized(auth.reason);

  const server = createStarProjectServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await runAsIdentity(auth.identity, () =>
      transport.handleRequest(req, {
        authInfo: {
          token: auth.tokenId,
          clientId: auth.identity.email,
          scopes: [],
          extra: { identity: auth.identity, userId: auth.userId },
        },
      }),
    );
  } finally {
    // JSON mode: the response body is complete when handleRequest resolves.
    void transport.close().catch(() => undefined);
  }
}

export const POST = handle;

// Stateless: there is no session to stream to or delete. Answer 405 rather
// than opening an SSE stream the finally block above would close at once.
function notAllowed() {
  return NextResponse.json(
    { error: "method_not_allowed", hint: "This MCP endpoint is stateless; send JSON-RPC with POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
export const GET = notAllowed;
export const DELETE = notAllowed;

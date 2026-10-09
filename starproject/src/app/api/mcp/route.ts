import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";

import { authenticateBearer } from "@/lib/apiTokens";
import { runAsIdentity } from "@/lib/auth";
import { createStarProjectServer } from "@/mcp/server";

// The MCP endpoint. Streamable HTTP, stateless: each request gets its own
// server + transport and is answered as JSON. Identity is a personal access
// token (Settings → API tokens) in `Authorization: Bearer sp_…`; Caddy routes
// /api/mcp* around forward_auth and strips X-Auth-* so the token is the only
// identity this path can carry (deploy/ec2/caddy/Caddyfile).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REALM = 'Bearer realm="starproject-mcp"';

function unauthorized(reason: string) {
  return NextResponse.json(
    { error: "unauthorized", reason, hint: "Send `Authorization: Bearer <token>`; mint one under Settings → API tokens." },
    { status: 401, headers: { "WWW-Authenticate": REALM } },
  );
}

async function handle(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req.headers.get("authorization"));
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
export const GET = handle;
export const DELETE = handle;

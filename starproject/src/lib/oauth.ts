import { createHash, randomBytes } from "node:crypto";

import { hashToken, mintToken, type TokenScope } from "@/lib/apiTokens";
import { prisma } from "@/lib/db";

// OAuth 2.1 for MCP clients that cannot send a header token -- claude.ai's custom
// connectors above all. STARProject is the authorization server for both of
// STAR's MCP servers (this app's /api/mcp and the design tools on the apps box),
// as it already is the token issuer for both. docs/MCP.md has the flow.
//
//   /.well-known/oauth-authorization-server   metadata (RFC 8414)    public
//   /oauth/register                           client registration    public
//   /oauth/authorize                          consent page           cookie-gated
//   /oauth/token                              code → token           public
//
// The consent page sits behind Caddy's @berkeley.edu gate like every other page,
// so whoever passes the STAR login is who the token belongs to; the account the
// client itself is signed in with never enters into it. The token handed back is
// an ordinary ApiToken (sp_…), scoped to the one server named by `resource`, so
// it lists and revokes under Settings → API tokens and design-mcp checks it
// through /api/mcp/verify unchanged. It does not expire on its own, like every
// other ApiToken; there are no refresh tokens.

export const CODE_TTL_MS = 5 * 60_000;
const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 10;

/** This app's public origin, e.g. https://project.starberkeley.org. Also the OAuth issuer. */
export function issuer(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** The MCP server URL each scope's tokens are for (RFC 8707 resource indicators). */
export function resources(): Record<TokenScope, string> {
  return {
    starproject: `${issuer()}/api/mcp`,
    design: (process.env.DESIGN_MCP_RESOURCE || "https://mcp.starberkeley.org/mcp").replace(/\/+$/, ""),
  };
}

/**
 * The scope a client is asking for. `resource` (what claude.ai sends) wins;
 * without one, a `scope` naming exactly one server will do. Null when neither
 * names a server we know: a token is only ever minted for one.
 */
export function scopeFor(resource: string | null | undefined, scope: string | null | undefined): TokenScope | null {
  if (resource) {
    const want = resource.replace(/\/+$/, "");
    const hit = (Object.entries(resources()) as [TokenScope, string][]).find(([, url]) => url === want);
    return hit ? hit[0] : null;
  }
  const asked = (scope ?? "").split(/\s+/).filter(Boolean);
  if (asked.length === 1 && (asked[0] === "starproject" || asked[0] === "design")) return asked[0];
  return null;
}

export const SCOPE_LABELS: Record<TokenScope, { title: string; detail: string }> = {
  design: {
    title: "STAR design tools",
    detail: "Read your designs, Layer X burns, DAQ runs, feed-twin records and rocket simulations. Read-only.",
  },
  starproject: {
    title: "STAR Project",
    detail: "Read and change tasks, projects, purchase requests and finance as you, with your permissions.",
  },
};

// Where a client may send the code back to. Registration is open to anyone (it
// has to be, for claude.ai), so this list is what stops a stranger registering
// a client that sends a member's code to their own site. Loopback is allowed for
// clients on the person's own machine (Claude Code, Claude Desktop, mcp-remote).
const CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

function extraCallbacks(): string[] {
  return (process.env.OAUTH_EXTRA_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function redirectUriAllowed(uri: string): boolean {
  if (CALLBACKS.includes(uri) || extraCallbacks().includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // RFC 8252 §7.3: a loopback redirect on any port, plain http.
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.hash;
}

/** Who the consent page says the code goes to: a host people recognise, not the client's self-chosen name. */
export function describeRedirect(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:") return `an app on this computer (${u.host})`;
  return u.host;
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["starproject", "design"],
  };
}

/** RFC 9728 metadata for this app's own MCP endpoint. */
export function protectedResourceMetadata() {
  return {
    resource: resources().starproject,
    authorization_servers: [issuer()],
    scopes_supported: ["starproject"],
    bearer_methods_supported: ["header"],
  };
}

export type OAuthError = { error: string; error_description: string };

const fail = (error: string, error_description: string): OAuthError => ({ error, error_description });

// ── registration ────────────────────────────────────────────────────────────

export async function registerClient(body: unknown) {
  const { redirect_uris, client_name } = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.length > MAX_REDIRECT_URIS) {
    return fail("invalid_redirect_uri", "Send redirect_uris: a list of 1 to 10 URIs.");
  }
  const uris = redirect_uris.filter((u): u is string => typeof u === "string");
  const refused = uris.length !== redirect_uris.length ? "a non-string" : uris.find((u) => !redirectUriAllowed(u));
  if (refused) {
    return fail(
      "invalid_redirect_uri",
      `Redirect URI ${JSON.stringify(refused)} is not allowed: only claude.ai's callback and loopback addresses are.`,
    );
  }
  const name = (typeof client_name === "string" ? client_name.trim() : "").slice(0, MAX_CLIENT_NAME) || "MCP client";
  const client = await prisma.oAuthClient.create({ data: { name, redirectUris: uris } });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    // A public client: PKCE proves the exchange, no secret is issued.
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

// ── authorization ───────────────────────────────────────────────────────────

export type AuthorizeParams = {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
};

export type AuthorizeRequest = {
  client: { id: string; name: string };
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: TokenScope;
};

/**
 * Check an authorization request. `fatal` errors are shown on the page: the
 * client or redirect URI cannot be trusted, so nothing may be sent to it.
 * `redirect` errors go back to the (verified) redirect URI, as RFC 6749 says.
 */
export async function checkAuthorize(
  p: AuthorizeParams,
): Promise<
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; fatal: string }
  | { ok: false; redirect: string }
> {
  if (!p.client_id) return { ok: false, fatal: "The request names no client (client_id)." };
  const client = await prisma.oAuthClient.findUnique({ where: { id: p.client_id } });
  if (!client) return { ok: false, fatal: "That client isn't registered here. Remove the connector and add it again." };
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri) || !redirectUriAllowed(redirectUri)) {
    return { ok: false, fatal: "The redirect URI doesn't match the one this client registered." };
  }
  const back = (e: OAuthError) => ({ ok: false as const, redirect: errorRedirect(redirectUri, e, p.state) });
  if (p.response_type !== "code") return back(fail("unsupported_response_type", "Only response_type=code."));
  if (!p.code_challenge || p.code_challenge_method !== "S256") {
    return back(fail("invalid_request", "PKCE with code_challenge_method=S256 is required."));
  }
  const scope = scopeFor(p.resource, p.scope);
  if (!scope) {
    return back(fail("invalid_target", "Name one STAR MCP server as resource (or scope starproject / design)."));
  }
  return {
    ok: true,
    req: { client: { id: client.id, name: client.name }, redirectUri, codeChallenge: p.code_challenge, state: p.state ?? null, scope },
  };
}

export function errorRedirect(redirectUri: string, e: OAuthError, state: string | null | undefined): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", e.error);
  u.searchParams.set("error_description", e.error_description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer());
  return u.toString();
}

/** Issue a code for an approved request; returns where to send the browser. */
export async function issueCode(req: AuthorizeRequest, userId: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  // Housekeeping: codes are dead minutes after they're made; nothing reads old ones.
  await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 86_400_000) } } });
  await prisma.oAuthCode.create({
    data: {
      codeHash: hashToken(code),
      clientId: req.client.id,
      userId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scopes: [req.scope],
      expiresAt: new Date(now + CODE_TTL_MS),
    },
  });
  const u = new URL(req.redirectUri);
  u.searchParams.set("code", code);
  if (req.state) u.searchParams.set("state", req.state);
  u.searchParams.set("iss", issuer());
  return u.toString();
}

// ── token ───────────────────────────────────────────────────────────────────

export type TokenParams = {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  resource?: string;
};

export async function exchangeCode(
  p: TokenParams,
): Promise<{ ok: true; body: { access_token: string; token_type: "Bearer"; scope: string } } | { ok: false; status: number; body: OAuthError }> {
  const bad = (error: string, description: string, status = 400) => ({ ok: false as const, status, body: fail(error, description) });
  if (p.grant_type !== "authorization_code") return bad("unsupported_grant_type", "Only authorization_code.");
  if (!p.code || !p.code_verifier || !p.client_id) {
    return bad("invalid_request", "Send code, code_verifier and client_id.");
  }

  const row = await prisma.oAuthCode.findUnique({ where: { codeHash: hashToken(p.code) }, include: { client: true } });
  const invalid = bad("invalid_grant", "The code is unknown, expired or already used.");
  if (!row || row.clientId !== p.client_id) return invalid;
  if (row.usedAt) {
    // Second use: the code leaked somewhere. Kill what the first use got.
    if (row.tokenId) await prisma.apiToken.updateMany({ where: { id: row.tokenId, revokedAt: null }, data: { revokedAt: new Date() } });
    return invalid;
  }
  if (row.expiresAt.getTime() < Date.now()) return invalid;
  if (p.redirect_uri && p.redirect_uri !== row.redirectUri) return invalid;
  if (!pkceMatches(p.code_verifier, row.codeChallenge)) return bad("invalid_grant", "code_verifier doesn't match.");

  const scopes = row.scopes.filter((s): s is TokenScope => s === "starproject" || s === "design");
  if (p.resource && scopeFor(p.resource, null) !== scopes[0]) {
    return bad("invalid_target", "resource differs from the one authorized.");
  }

  // Claim the code before minting, so two racing exchanges cannot both win.
  const claimed = await prisma.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return invalid;

  const { token, view } = await mintToken(row.userId, `${row.client.name} (connector)`.slice(0, 60), scopes);
  await prisma.oAuthCode.update({ where: { id: row.id }, data: { tokenId: view.id } });
  return { ok: true, body: { access_token: token, token_type: "Bearer", scope: scopes.join(" ") } };
}

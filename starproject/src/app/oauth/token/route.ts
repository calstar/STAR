import { NextResponse } from "next/server";

import { exchangeCode, type TokenParams } from "@/lib/oauth";

// Code → token (RFC 6749 §4.1.3 with PKCE). Public: the client calls it from its
// own servers, with no STAR cookie. Clients are public, so a client secret sent
// anyway (HTTP Basic or in the body) is ignored; PKCE is what proves the caller.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache", "Access-Control-Allow-Origin": "*" };

function basicClientId(authorization: string | null): string | undefined {
  const m = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return undefined;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const id = decoded.split(":")[0];
  return id ? decodeURIComponent(id) : undefined;
}

export async function POST(req: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    form = new URLSearchParams();
  }
  const p: TokenParams = {
    grant_type: form.get("grant_type") ?? undefined,
    code: form.get("code") ?? undefined,
    redirect_uri: form.get("redirect_uri") ?? undefined,
    client_id: form.get("client_id") ?? basicClientId(req.headers.get("authorization")),
    code_verifier: form.get("code_verifier") ?? undefined,
    resource: form.get("resource") ?? undefined,
  };
  const out = await exchangeCode(p);
  return out.ok
    ? NextResponse.json(out.body, { headers: HEADERS })
    : NextResponse.json(out.body, { status: out.status, headers: HEADERS });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization" },
  });
}

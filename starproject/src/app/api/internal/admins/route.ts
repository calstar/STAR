import { NextResponse } from "next/server";

import { listAdmins } from "@/lib/admins";
import { internalSecretOk } from "@/lib/internalAuth";

export const dynamic = "force-dynamic";

// The effective admin list (seed − removed ∪ added), for the server-analytics hub,
// which admits exactly STARProject's admins. Called over the compose network
// with INTERNAL_API_SECRET; see server-analytics/internal/hub/admins.go.
export async function GET(req: Request) {
  if (!internalSecretOk(req.headers.get("x-internal-secret"), process.env.INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admins = await listAdmins();
  return NextResponse.json(
    { emails: admins.map((a) => a.email) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

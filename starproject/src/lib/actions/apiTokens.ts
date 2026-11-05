"use server";

import { revalidatePath } from "next/cache";

import { cleanScopes, listTokens, mintToken, revokeToken, type ApiTokenView } from "@/lib/apiTokens";
import { getCurrentDbUser } from "@/lib/user";

const MAX_NAME = 60;

/**
 * Create a personal access token; the plaintext is returned once. `scopes` picks
 * the MCP servers it opens (TOKEN_SCOPES): STARProject's own, the design tools',
 * or both. Returns an error string for a bad request rather than throwing, for
 * the same redaction reason as revokeApiToken below.
 */
export async function createApiToken(
  name: string,
  scopes: string[],
): Promise<{ token: string; view: ApiTokenView } | { error: string }> {
  const user = await getCurrentDbUser();
  const chosen = cleanScopes(scopes);
  if (!chosen) return { error: "Pick at least one of STAR Project or Design tools" };
  const clean = name.trim().slice(0, MAX_NAME) || "token";
  const made = await mintToken(user.id, clean, chosen);
  revalidatePath("/settings");
  return made;
}

// Returns an error string instead of throwing: a thrown server-action message
// is redacted in production, so the UI would only see "An error occurred".
export async function revokeApiToken(tokenId: string): Promise<{ error?: string }> {
  const user = await getCurrentDbUser();
  const done = await revokeToken(user.id, tokenId);
  if (!done) return { error: "That token isn't yours or is already revoked" };
  revalidatePath("/settings");
  return {};
}

export async function listApiTokens(): Promise<ApiTokenView[]> {
  const user = await getCurrentDbUser();
  return listTokens(user.id);
}

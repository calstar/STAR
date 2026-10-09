"use server";

import { revalidatePath } from "next/cache";

import { listTokens, mintToken, revokeToken, type ApiTokenView } from "@/lib/apiTokens";
import { getCurrentDbUser } from "@/lib/user";

const MAX_NAME = 60;

/** Create a personal access token for the MCP endpoint; the plaintext is returned once. */
export async function createApiToken(name: string): Promise<{ token: string; view: ApiTokenView }> {
  const user = await getCurrentDbUser();
  const clean = name.trim().slice(0, MAX_NAME) || "token";
  const made = await mintToken(user.id, clean);
  revalidatePath("/settings");
  return made;
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  const user = await getCurrentDbUser();
  const done = await revokeToken(user.id, tokenId);
  if (!done) throw new Error("That token isn't yours or is already revoked");
  revalidatePath("/settings");
}

export async function listApiTokens(): Promise<ApiTokenView[]> {
  const user = await getCurrentDbUser();
  return listTokens(user.id);
}

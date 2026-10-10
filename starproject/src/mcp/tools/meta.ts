import { z } from "zod";

import { isAdmin } from "@/lib/admins";
import { listTokens, revokeToken } from "@/lib/apiTokens";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

import { DESTRUCTIVE, READ, defineTool, type ToolModule } from "./_shared";

// Who am I, is the app up, and the caller's own API tokens. The worked example
// other modules copy: zod input, an annotation constant, a handler that returns
// plain data.
export const metaTools: ToolModule = (server) => {
  defineTool(
    server,
    "whoami",
    {
      description: "The user this token belongs to: id, email, display name, and whether they are an admin.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const user = await getCurrentDbUser();
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        displayName: displayNameOf(user),
        isAdmin: await isAdmin(user.email),
      };
    },
  );

  defineTool(
    server,
    "health",
    {
      description: "Database round-trip plus user, project and task counts (same as the /health page).",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await prisma.$queryRaw`SELECT 1`;
      const [users, projects, tasks] = await Promise.all([
        prisma.user.count(),
        prisma.project.count(),
        prisma.task.count(),
      ]);
      return { ok: true, users, projects, tasks };
    },
  );

  defineTool(
    server,
    "list_api_tokens",
    {
      description: "Your own MCP API tokens (prefix, name, created, last used, revoked). Never returns the token itself.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const user = await getCurrentDbUser();
      return listTokens(user.id);
    },
  );

  // Minting is deliberately NOT a tool: a leaked token could otherwise mint a
  // successor before it was revoked. Tokens are created under Settings → API
  // tokens (a browser session); revoking is fine to expose.
  defineTool(
    server,
    "revoke_api_token",
    {
      description: "Revoke one of your own MCP API tokens by id (from list_api_tokens). Revoking the token in use ends this session.",
      inputSchema: { tokenId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ tokenId }) => {
      const user = await getCurrentDbUser();
      const done = await revokeToken(user.id, tokenId);
      if (!done) throw new Error("That token isn't yours or is already revoked");
      return { revoked: tokenId };
    },
  );
};

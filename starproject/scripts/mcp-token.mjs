#!/usr/bin/env node
// Mint an MCP API token for a user straight into the database (local testing;
// in production people mint tokens under Settings → API tokens).
//
//   DATABASE_URL=postgresql://... node scripts/mcp-token.mjs you@berkeley.edu [name]
//
// Prints the token once. Same format as src/lib/apiTokens.ts: `sp_` + 32 random
// bytes base64url, stored as a SHA-256 hex hash with the first 8 chars as prefix.
import { createHash, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const [email, name = "local"] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error("usage: node scripts/mcp-token.mjs <email> [name]");
  process.exit(2);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: email.split("@")[0] },
    update: {},
  });
  const token = "sp_" + randomBytes(32).toString("base64url");
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      prefix: token.slice(0, 8),
    },
  });
  console.log(token);
} finally {
  await prisma.$disconnect();
}

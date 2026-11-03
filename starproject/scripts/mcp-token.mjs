#!/usr/bin/env node
// Mint an MCP API token for a user straight into the database (local testing;
// in production people mint tokens under Settings → API tokens).
//
//   DATABASE_URL=postgresql://... node scripts/mcp-token.mjs you@berkeley.edu [name] [scopes]
//
// scopes is a comma list of starproject,design (default starproject) -- the MCP
// servers the token opens; TOKEN_SCOPES in src/lib/apiTokens.ts.
//
// Prints the token once. Same format as src/lib/apiTokens.ts: `sp_` + 32 random
// bytes base64url, stored as a SHA-256 hex hash with the first 8 chars as prefix.
import { createHash, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const [rawEmail, name = "local", rawScopes = "starproject"] = process.argv.slice(2);
const KNOWN = ["starproject", "design"];
const scopes = rawScopes.split(",").map((s) => s.trim()).filter(Boolean);
if (scopes.length === 0 || scopes.some((s) => !KNOWN.includes(s))) {
  console.error(`scopes must be a comma list of ${KNOWN.join(", ")}; got ${JSON.stringify(rawScopes)}`);
  process.exit(2);
}
// Same normalisation as the admin list: one User row per address, whatever the case typed.
const email = (rawEmail ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("usage: node scripts/mcp-token.mjs <email> [name] [starproject,design]");
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
      scopes,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      prefix: token.slice(0, 8),
    },
  });
  console.log(token);
} finally {
  await prisma.$disconnect();
}

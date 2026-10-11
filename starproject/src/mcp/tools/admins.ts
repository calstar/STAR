import { z } from "zod";

import { addAdmin, removeAdmin } from "@/lib/actions/admins";
import { isAdmin, listAdmins, SEED_ADMIN_EMAILS } from "@/lib/admins";
import { getCurrentDbUser } from "@/lib/user";

import { DESTRUCTIVE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// The admin allowlist (Workspace setup → Admins). Admins gate the destructive
// actions (delete task/project/subteam) and the list itself; everyone can read
// it. The actions enforce "admins only" themselves (requireAdmin).

export type AdminRow = { email: string; seed: boolean };

/**
 * Mark each effective admin as a seed (hardcoded in src/lib/admins.ts, kept
 * unless tombstoned) or one added at runtime. Compared lowercased, as isAdmin is.
 */
export function classifyAdmins(admins: { email: string }[], seeds: readonly string[]): AdminRow[] {
  const seedSet = new Set(seeds.map((e) => e.toLowerCase()));
  return admins.map(({ email }) => ({ email, seed: seedSet.has(email.toLowerCase()) }));
}

async function adminList() {
  const [admins, me] = await Promise.all([listAdmins(), getCurrentDbUser()]);
  return {
    admins: classifyAdmins(admins, SEED_ADMIN_EMAILS),
    isAdmin: await isAdmin(me.email),
  };
}

export const adminTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_admins",
    {
      description:
        "The effective admin emails (Workspace setup → Admins), each marked seed (built into the code) or added at runtime, " +
        "plus whether you are an admin.",
      inputSchema: {},
      annotations: READ,
    },
    async () => adminList(),
  );

  defineTool(
    server,
    "add_admin",
    {
      description:
        "Admins only. Grant admin to an email (Workspace setup → Admins → Add). Re-adding a removed seed admin " +
        "clears its tombstone. Returns the refreshed list.",
      inputSchema: { email: z.string().trim().min(1).max(254).describe("The email to make an admin") },
      annotations: WRITE,
    },
    async ({ email }) => {
      await addAdmin(email);
      return adminList();
    },
  );

  defineTool(
    server,
    "remove_admin",
    {
      description:
        "Admins only. Revoke admin from an email (Workspace setup → Admins → Remove); a seed admin is tombstoned so it " +
        "stays removed. Refuses to remove the last admin. Returns the refreshed list.",
      inputSchema: { email: z.string().trim().min(1).max(254).describe("The admin email to remove") },
      annotations: DESTRUCTIVE,
    },
    async ({ email }) => {
      await removeAdmin(email);
      return adminList();
    },
  );
};

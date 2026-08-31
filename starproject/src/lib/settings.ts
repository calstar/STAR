import { prisma } from "@/lib/db";
import { getCurrentDbUser } from "@/lib/user";

/** Get (creating defaults if missing) a user's settings row. */
export async function getSettings(userId: string) {
  return prisma.userSettings.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function getCurrentSettings() {
  const user = await getCurrentDbUser();
  const settings = await getSettings(user.id);
  return { user, settings };
}

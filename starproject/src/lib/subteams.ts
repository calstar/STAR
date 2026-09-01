import { prisma } from "@/lib/db";

/** All subteams, for pickers and filters. */
export function getSubteams() {
  return prisma.subteam.findMany({ orderBy: { name: "asc" } });
}

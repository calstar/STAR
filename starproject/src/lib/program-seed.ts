import { prisma } from "@/lib/db";

/** Start every subteam already working in a project at its first phase, so a
 * newly tracked project (or one just moved under a tracked one) doesn't show
 * up empty. Only the project's own tasks count; existing rows are kept. */
export async function seedSubteamPhases(projectId: string) {
  const working = await prisma.task.findMany({
    where: { projectId, subteamId: { not: null } },
    distinct: ["subteamId"],
    select: { subteamId: true },
  });
  await prisma.subteamPhase.createMany({
    data: working.map((t) => ({ projectId, subteamId: t.subteamId! })),
    skipDuplicates: true,
  });
}

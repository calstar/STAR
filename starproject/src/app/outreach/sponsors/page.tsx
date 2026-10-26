import { SponsorsWorkspace } from "@/components/outreach/SponsorsWorkspace";
import { seasonOf } from "@/lib/outreach/constants";
import { listDeals, listSeasons, outreachViewer, unlinkedOutreachTasks } from "@/lib/outreach/queries";
import { getTeamUsers } from "@/lib/user";
import { displayNameOf } from "@/lib/names";
import { orgFromTaskTitle } from "@/lib/outreach/tracker";

export const dynamic = "force-dynamic";

export default async function SponsorsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; stage?: string }>;
}) {
  const sp = await searchParams;
  const season = sp.season ?? seasonOf(new Date());
  const [{ user }, deals, seasons, tasks, team] = await Promise.all([
    outreachViewer(),
    listDeals(season === "all" ? undefined : season),
    listSeasons(),
    unlinkedOutreachTasks(),
    getTeamUsers(),
  ]);
  return (
    <SponsorsWorkspace
      deals={deals}
      season={season}
      seasons={seasons}
      initialStage={sp.stage ?? null}
      unlinkedTasks={tasks.filter((t) => orgFromTaskTitle(t.title)).length}
      viewerEmail={user.email}
      team={team.map((u) => ({ id: u.id, name: displayNameOf(u) }))}
    />
  );
}

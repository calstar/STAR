import { SponsorsWorkspace } from "@/components/outreach/SponsorsWorkspace";
import { seasonOf } from "@/lib/outreach/constants";
import { listDeals, listSeasons, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function SponsorsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; stage?: string }>;
}) {
  // Non-admins see the layout's notice; nothing here may load for them.
  const { user, admin } = await outreachViewer();
  if (!admin) return null;
  const sp = await searchParams;
  const season = sp.season ?? seasonOf(new Date());
  const [deals, seasons] = await Promise.all([listDeals(season === "all" ? undefined : season), listSeasons()]);
  return (
    <SponsorsWorkspace
      deals={deals}
      season={season}
      seasons={seasons}
      initialStage={sp.stage ?? null}
      viewerEmail={user.email}
    />
  );
}

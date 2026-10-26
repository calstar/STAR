import { ImportWorkspace } from "@/components/outreach/ImportWorkspace";
import { seasonOf } from "@/lib/outreach/constants";
import { listCampaigns, listSeasons, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const [campaigns, seasons] = await Promise.all([listCampaigns(), listSeasons()]);
  return (
    <ImportWorkspace campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} seasons={seasons} currentSeason={seasonOf(new Date())} />
  );
}

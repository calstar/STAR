import { ListBuilder } from "@/components/outreach/ListBuilder";
import { seasonOf } from "@/lib/outreach/constants";
import { allReferrers, allTags, listCampaigns, listSeasons, listSegments, outreachViewer } from "@/lib/outreach/queries";
import { segmentFilterSchema, type SegmentFilter } from "@/lib/outreach/segments";

export const dynamic = "force-dynamic";

export default async function ListsPage({ searchParams }: { searchParams: Promise<{ filter?: string; id?: string }> }) {
  const sp = await searchParams;
  const [{ user }, lists, tags, referrers, campaigns, seasons] = await Promise.all([
    outreachViewer(),
    listSegments(),
    allTags(),
    allReferrers(),
    listCampaigns(),
    listSeasons(),
  ]);
  let initial: SegmentFilter = {};
  if (sp.filter) {
    try {
      initial = segmentFilterSchema.parse(JSON.parse(sp.filter));
    } catch {
      initial = {};
    }
  }
  return (
    <ListBuilder
      lists={lists}
      tags={tags.map((t) => t.tag)}
      referrers={referrers}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))}
      seasons={seasons}
      currentSeason={seasonOf(new Date())}
      initialFilter={initial}
      initialListId={sp.id ?? null}
      viewerEmail={user.email}
    />
  );
}

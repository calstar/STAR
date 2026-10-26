import { PeopleWorkspace } from "@/components/outreach/PeopleWorkspace";
import { allTags, listContacts, outreachViewer } from "@/lib/outreach/queries";
import type { SegmentFilter } from "@/lib/outreach/segments";

export const dynamic = "force-dynamic";

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; aff?: string; page?: string; dnc?: string }>;
}) {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const sp = await searchParams;
  const filter: SegmentFilter = {
    search: sp.q || undefined,
    tagsAny: sp.tag ? sp.tag.split(",") : undefined,
    affiliations: sp.aff ? sp.aff.split(",") : undefined,
    includeExcluded: sp.dnc !== "hide",
  };
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const [{ total, rows }, tags] = await Promise.all([listContacts(filter, page), allTags()]);
  return <PeopleWorkspace rows={rows} total={total} page={page} tags={tags} params={sp} />;
}

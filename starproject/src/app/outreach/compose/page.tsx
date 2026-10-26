import { ComposeWorkspace } from "@/components/outreach/ComposeWorkspace";
import { seasonOf } from "@/lib/outreach/constants";
import {
  composeRows,
  listCampaigns,
  listSeasons,
  listSegments,
  listTemplates,
  outreachViewer,
  recentlySent,
  type ComposeSource,
} from "@/lib/outreach/queries";
import { displayNameOf } from "@/lib/names";

export const dynamic = "force-dynamic";

type SP = { list?: string; stages?: string; season?: string; deal?: string; contact?: string; template?: string; campaign?: string };

export default async function ComposePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { user } = await outreachViewer();
  let source: ComposeSource | null = null;
  if (sp.list) source = { kind: "list", listId: sp.list };
  else if (sp.deal) source = { kind: "deal", dealId: sp.deal };
  else if (sp.contact) source = { kind: "contact", contactId: sp.contact };
  else if (sp.stages) source = { kind: "deals", stages: sp.stages.split(","), season: sp.season ?? seasonOf(new Date()) };

  const sender = { name: user.name ?? displayNameOf(user), email: user.email };
  const [lists, templates, campaigns, seasons, rows] = await Promise.all([
    listSegments(),
    listTemplates(),
    listCampaigns(),
    listSeasons(),
    source ? composeRows(source, sender) : Promise.resolve([]),
  ]);
  const templateId = sp.template ?? null;
  const sent = await recentlySent(templateId, rows);
  const campaign = campaigns.find((c) => c.id === sp.campaign) ?? null;

  return (
    <ComposeWorkspace
      // A new template (or source) starts a fresh merge: subject/body/sent state reset.
      key={`${templateId}|${JSON.stringify(source)}`}
      params={sp}
      source={source}
      rows={rows.map((r) => ({ ...r, vars: { ...r.vars, campaign_url: campaign?.url ?? null } }))}
      lists={lists.map((l) => ({ id: l.id, name: l.name, count: l.count }))}
      templates={templates}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
      seasons={seasons}
      sent={sent}
      viewerEmail={user.email}
    />
  );
}

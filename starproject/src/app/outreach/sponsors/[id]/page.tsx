import Link from "next/link";
import { notFound } from "next/navigation";

import { DealEditor } from "@/components/outreach/DealEditor";
import { DealQuickActions } from "@/components/outreach/DealQuickActions";
import { OrgContacts, OrgEditor } from "@/components/outreach/OrgEditor";
import { TouchLog } from "@/components/outreach/TouchLog";
import { CARD, MUTED, PILL, STAGE_TONE } from "@/components/outreach/ui";
import { STAGE_LABEL, type DealStage } from "@/lib/outreach/constants";
import { getDealDetail, listCampaigns, listTemplates, outreachViewer } from "@/lib/outreach/queries";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getTeamUsers } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ user }, detail, team, templates, campaigns] = await Promise.all([
    outreachViewer(),
    getDealDetail(id),
    getTeamUsers(),
    listTemplates(),
    listCampaigns(),
  ]);
  if (!detail) notFound();
  const { deal, touches, otherSeasons } = detail;
  const org = await prisma.outreachOrg.findUniqueOrThrow({ where: { id: deal.orgId } });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/outreach/sponsors" className={`text-sm ${MUTED} hover:underline`}>
          ← Sponsors
        </Link>
        <h2 className="text-xl font-semibold">{deal.orgName}</h2>
        <span className={`${PILL} ${STAGE_TONE[deal.stage]}`}>{STAGE_LABEL[deal.stage as DealStage]}</span>
        <span className={`text-sm ${MUTED}`}>{deal.season}</span>
        {deal.attention && <span className="text-sm text-amber-800 dark:text-amber-300">{deal.attention.label}</span>}
        <span className="ml-auto">
          <DealQuickActions deal={deal} viewerEmail={user.email} />
        </span>
      </div>
      {otherSeasons.length > 0 && (
        <p className={`text-sm ${MUTED}`}>
          Other seasons:{" "}
          {otherSeasons.map((o, i) => (
            <span key={o.id}>
              {i > 0 && " · "}
              <Link className="hover:underline" href={`/outreach/sponsors/${o.id}`}>
                {o.season} ({STAGE_LABEL[o.stage as DealStage] ?? o.stage}
                {o.theirDeliverables ? `, ${o.theirDeliverables}` : ""})
              </Link>
            </span>
          ))}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <DealEditor deal={deal} team={team.map((u) => ({ id: u.id, name: displayNameOf(u) }))} />
          <TouchLog
            touches={touches}
            target={{ dealId: deal.id, orgId: deal.orgId }}
            contacts={deal.contacts}
            templates={templates.map((t) => ({ id: t.id, name: t.name }))}
            campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
            defaultKind={deal.channel === "form" ? "form_submitted" : "email_sent"}
          />
        </div>
        <div className="space-y-4">
          <OrgContacts orgId={deal.orgId} orgName={deal.orgName} contacts={deal.contacts} viewerEmail={user.email} />
          <OrgEditor
            org={{
              id: org.id,
              name: org.name,
              kind: org.kind,
              website: org.website,
              industry: org.industry,
              channel: org.channel,
              formUrl: org.formUrl,
              notes: org.notes,
            }}
          />
          {deal.task && (
            <div className={`${CARD} p-4 text-sm`}>
              From the task board:{" "}
              <Link className="text-blue-600 hover:underline" href={`/tasks?task=${deal.task.id}`}>
                #{deal.task.number} {deal.task.title}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

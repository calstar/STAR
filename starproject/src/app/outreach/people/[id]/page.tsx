import Link from "next/link";
import { notFound } from "next/navigation";

import { ContactEditor } from "@/components/outreach/ContactEditor";
import { dollars, shortDate } from "@/components/outreach/format";
import { TouchLog } from "@/components/outreach/TouchLog";
import { CARD, MUTED, TAG } from "@/components/outreach/ui";
import { gmailComposeUrl } from "@/lib/outreach/compose";
import { getContactDetail, listCampaigns, listTemplates, outreachViewer, personName } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const { id } = await params;
  const [{ user }, detail, templates, campaigns] = await Promise.all([
    outreachViewer(),
    getContactDetail(id),
    listTemplates(),
    listCampaigns(),
  ]);
  if (!detail) notFound();
  const { contact: c, touches } = detail;
  const name = personName(c) || c.email || "(no name)";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/outreach/people" className={`text-sm ${MUTED} hover:underline`}>
          ← People
        </Link>
        <h2 className="text-xl font-semibold">{name}</h2>
        {c.org && <span className={MUTED}>{c.org.name}</span>}
        {c.tags.map((t) => (
          <span key={t} className={TAG}>
            {t}
          </span>
        ))}
        {c.email && !c.doNotContact && (
          <a
            className="ml-auto text-sm text-blue-600 hover:underline"
            href={gmailComposeUrl({ to: [c.email], authuser: user.email })}
            target="_blank"
            rel="noreferrer"
          >
            ✉ Write in Gmail
          </a>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <ContactEditor contact={c} />
          <TouchLog
            touches={touches}
            target={{ contactId: c.id, orgId: c.org?.id }}
            templates={templates.map((t) => ({ id: t.id, name: t.name }))}
            campaigns={campaigns.map((x) => ({ id: x.id, name: x.name }))}
          />
        </div>
        <div className="space-y-4">
          <div className={`${CARD} p-4`}>
            <h3 className="mb-2 font-semibold">Gifts</h3>
            {c.donations.length === 0 ? (
              <p className={`text-sm ${MUTED}`}>No gifts recorded.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {c.donations.map((d) => (
                  <li key={d.id} className="flex flex-wrap gap-x-2">
                    <span className="font-medium tabular-nums">{dollars(d.amountCents)}</span>
                    <span>{shortDate(d.donatedAt)}</span>
                    {d.campaign && (
                      <Link className="text-blue-600 hover:underline" href={`/outreach/campaigns/${d.campaign.id}`}>
                        {d.campaign.name}
                      </Link>
                    )}
                    {d.perkName && (
                      <span className={MUTED}>
                        {d.perkName} ({d.perkStatus})
                      </span>
                    )}
                    {d.displayPref && d.displayPref !== "display" && <span className="text-xs text-amber-700">{d.displayPref}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`${CARD} p-4`}>
            <h3 className="mb-2 font-semibold">Brought in by</h3>
            {c.referrals.length === 0 ? (
              <p className={`text-sm ${MUTED}`}>No referrer recorded.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {c.referrals.map((r) => (
                  <li key={r.id}>
                    {r.ambassadorName ?? r.ambassadorEmail}
                    {r.ambassadorName && r.ambassadorEmail ? ` (${r.ambassadorEmail})` : ""}
                    {r.campaign && <span className={MUTED}> · {r.campaign}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className={`text-xs ${MUTED}`}>
            Source: {c.source ?? "unknown"} · added {shortDate(c.createdAt)}
          </p>
        </div>
      </div>
    </div>
  );
}

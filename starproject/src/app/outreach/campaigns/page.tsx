import Link from "next/link";

import { CampaignForm } from "@/components/outreach/CampaignForm";
import { dollars, shortDate, titleCase } from "@/components/outreach/format";
import { CARD, MUTED } from "@/components/outreach/ui";
import { listCampaigns, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const campaigns = await listCampaigns();
  return (
    <div className="space-y-4">
      <CampaignForm />
      {campaigns.length === 0 && <p className={`text-sm ${MUTED}`}>No campaigns yet. Add the current crowdfunding campaign above.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {campaigns.map((c) => {
          const pct = c.goalCents ? Math.min(100, Math.round((c.raisedCents / c.goalCents) * 100)) : null;
          return (
            <Link key={c.id} href={`/outreach/campaigns/${c.id}`} className={`${CARD} block p-4 hover:border-blue-300`}>
              <div className="flex items-baseline justify-between">
                <h2 className="font-semibold">{c.name}</h2>
                <span className={`text-xs ${MUTED}`}>{titleCase(c.kind)}</span>
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {dollars(c.raisedCents)}
                {c.goalCents ? <span className={`ml-2 text-sm font-normal ${MUTED}`}>of {dollars(c.goalCents)}</span> : null}
              </div>
              {pct != null && (
                <div className="mt-2 h-2 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                  <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className={`mt-2 text-sm ${MUTED}`}>
                {c.gifts} gifts from {c.donors} donors · {shortDate(c.startsAt)} – {shortDate(c.endsAt)}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

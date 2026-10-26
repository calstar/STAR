import Link from "next/link";
import { notFound } from "next/navigation";

import { CampaignDonations } from "@/components/outreach/CampaignDonations";
import { CampaignForm } from "@/components/outreach/CampaignForm";
import { dollars, shortDate } from "@/components/outreach/format";
import { CARD, MUTED, TD, TH } from "@/components/outreach/ui";
import { calendarDaysUntil, daysLeftLabel } from "@/lib/outreach/followups";
import { getCampaignDetail, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const { id } = await params;
  const d = await getCampaignDetail(id);
  if (!d) notFound();
  const { campaign: c, donations, leaderboard } = d;
  const raised = donations.reduce((s, x) => s + x.amountCents, 0);
  const donors = new Set(donations.map((x) => x.contact.id)).size;
  const pct = c.goalCents ? Math.min(100, Math.round((raised / c.goalCents) * 100)) : null;
  const left = c.endsAt && new Date(c.endsAt) >= new Date() ? calendarDaysUntil(new Date(c.endsAt), new Date()) : null;
  const perksPending = donations.filter((x) => x.perkStatus === "pending").length;
  const listLink = (filter: object) => `/outreach/lists?filter=${encodeURIComponent(JSON.stringify(filter))}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <Link href="/outreach/campaigns" className={`text-sm ${MUTED} hover:underline`}>
          ← Campaigns
        </Link>
        <h2 className="text-xl font-semibold">{c.name}</h2>
        {c.url && (
          <a className="text-sm text-blue-600 hover:underline" href={c.url} target="_blank" rel="noreferrer">
            Campaign page ↗
          </a>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className={`${CARD} p-4 sm:col-span-2`}>
          <div className="text-3xl font-semibold tabular-nums">
            {dollars(raised)}
            {c.goalCents ? <span className={`ml-2 text-base font-normal ${MUTED}`}>of {dollars(c.goalCents)}</span> : null}
          </div>
          {pct != null && (
            <div className="mt-2 h-2 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
              <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className={`mt-2 text-sm ${MUTED}`}>
            {donations.length} gifts · {donors} donors · {shortDate(c.startsAt)} – {shortDate(c.endsAt)}
            {left != null && left >= 0 ? ` · closes ${daysLeftLabel(left)}` : ""}
          </p>
        </div>
        <div className={`${CARD} p-4`}>
          <div className={`text-xs font-medium uppercase ${MUTED}`}>Perks to send</div>
          <div className="text-2xl font-semibold">{perksPending}</div>
          <div className={`text-xs ${MUTED}`}>thank-you due {shortDate(c.thankYouDueAt)}</div>
        </div>
        <div className={`${CARD} space-y-1 p-4 text-sm`}>
          <div className={`text-xs font-medium uppercase ${MUTED}`}>Lists</div>
          <Link className="block text-blue-600 hover:underline" href={listLink({ notDonatedTo: c.id, tagsNone: ["sponsor-contact"] })}>
            Everyone who hasn&apos;t given →
          </Link>
          <Link className="block text-blue-600 hover:underline" href={listLink({ donatedTo: c.id })}>
            Donors (for the thank-you) →
          </Link>
          <Link className="block text-blue-600 hover:underline" href={listLink({ donatedTo: "any", notDonatedTo: c.id })}>
            Gave before, not this time →
          </Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CampaignDonations donations={donations} />
        <div className="space-y-4">
          <div className={CARD}>
            <h3 className="border-b border-neutral-200 p-3 font-semibold dark:border-neutral-800">Ambassadors</h3>
            {leaderboard.length === 0 ? (
              <p className={`p-3 text-sm ${MUTED}`}>Import member contact lists with this campaign selected to see who brought in whom.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={TH}>Member</th>
                    <th className={`${TH} text-right`}>Contacts</th>
                    <th className={`${TH} text-right`}>Gave</th>
                    <th className={`${TH} text-right`}>Credited</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {leaderboard.map((b) => (
                    <tr key={b.member}>
                      <td className={TD}>{b.member}</td>
                      <td className={`${TD} text-right tabular-nums`}>{b.supplied}</td>
                      <td className={`${TD} text-right tabular-nums`}>{b.gave}</td>
                      <td className={`${TD} text-right tabular-nums`}>{b.raisedCents ? dollars(b.raisedCents) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <CampaignForm campaign={c} />
        </div>
      </div>
    </div>
  );
}

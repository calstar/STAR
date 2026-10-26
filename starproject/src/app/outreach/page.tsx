import Link from "next/link";

import { DealQuickActions } from "@/components/outreach/DealQuickActions";
import { dollars, relative, shortDate, titleCase } from "@/components/outreach/format";
import { CARD, MUTED, PILL, STAGE_TONE } from "@/components/outreach/ui";
import { DEAL_STAGES, STAGE_LABEL, TOUCH_LABEL, type TouchKind } from "@/lib/outreach/constants";
import { daysLeftLabel } from "@/lib/outreach/followups";
import { dashboard, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function OutreachToday() {
  const [{ user }, d] = await Promise.all([outreachViewer(), dashboard()]);
  const empty = d.contacts === 0 && d.queue.length === 0 && d.openCount === 0 && d.wonCount === 0;

  return (
    <div className="space-y-6">
      {empty && (
        <div className={`${CARD} p-5`}>
          <h2 className="text-lg font-semibold">Nothing here yet</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Start by pasting a sheet into <Link className="text-blue-600 hover:underline" href="/outreach/import">Import</Link>{" "}
            (the Current Sponsors List, a member contact list, or a ScaleFunder export), or bring the Outreach
            Correspondence tasks over from <Link className="text-blue-600 hover:underline" href="/outreach/sponsors">Sponsors</Link>.
          </p>
        </div>
      )}

      {d.activeCampaigns.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {d.activeCampaigns.map((c) => {
            const pct = c.goalCents ? Math.min(100, Math.round((c.raisedCents / c.goalCents) * 100)) : null;
            const ms = d.milestones.filter((m) => m.campaignId === c.id);
            return (
              <Link key={c.id} href={`/outreach/campaigns/${c.id}`} className={`${CARD} block p-4 hover:border-blue-300`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="font-semibold">{c.name}</h2>
                  <span className={`text-xs ${MUTED}`}>{titleCase(c.kind)}</span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{dollars(c.raisedCents)}</span>
                  {c.goalCents ? <span className={`text-sm ${MUTED}`}>of {dollars(c.goalCents)}</span> : null}
                  <span className={`ml-auto text-sm ${MUTED}`}>
                    {c.gifts} gifts · {c.donors} donors
                  </span>
                </div>
                {pct != null && (
                  <div className="mt-2 h-2 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                    <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
                  </div>
                )}
                {ms.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm">
                    {ms.map((m) => (
                      <li key={m.label} className={m.daysLeft <= 7 ? "font-medium text-red-700 dark:text-red-300" : ""}>
                        ⏳ {m.label} {daysLeftLabel(m.daysLeft)} ({shortDate(m.at)})
                      </li>
                    ))}
                  </ul>
                )}
              </Link>
            );
          })}
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-4">
        <Stat label={`Committed ${d.season}`} value={dollars(d.wonCents)} sub={`${d.wonCount} sponsors`} />
        <Stat label="Open conversations" value={String(d.openCount)} sub="prospect → in talks" />
        <Stat label="Need you today" value={String(d.queue.length)} sub="follow-ups, forms, renewals" />
        <Stat label="People" value={String(d.contacts)} sub={`${d.donors} have given`} />
      </section>

      <section className={`${CARD} p-4`}>
        <h2 className="mb-2 font-semibold">Pipeline {d.season}</h2>
        <div className="flex flex-wrap gap-2">
          {DEAL_STAGES.map((s) => (
            <Link key={s} href={`/outreach/sponsors?stage=${s}`} className={`${PILL} ${STAGE_TONE[s]} gap-1.5 px-3 py-1`}>
              {STAGE_LABEL[s]} <span className="tabular-nums opacity-80">{d.byStage[s] ?? 0}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className={CARD}>
        <div className="flex items-baseline justify-between border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-semibold">Needs attention</h2>
          <span className={`text-xs ${MUTED}`}>Sorted by how overdue</span>
        </div>
        {d.queue.length === 0 ? (
          <p className={`p-4 text-sm ${MUTED}`}>You&apos;re caught up. Nothing is overdue.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {d.queue.slice(0, 60).map((deal) => (
              <li key={deal.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Link href={`/outreach/sponsors/${deal.id}`} className="min-w-40 font-medium hover:text-blue-600">
                  {deal.orgName}
                </Link>
                <span className={`${PILL} ${STAGE_TONE[deal.stage]}`}>{STAGE_LABEL[deal.stage as keyof typeof STAGE_LABEL]}</span>
                <span className="text-sm text-amber-800 dark:text-amber-300">{deal.attention!.label}</span>
                {deal.ask && <span className={`hidden text-sm lg:inline ${MUTED}`}>· {deal.ask}</span>}
                <span className="ml-auto">
                  <DealQuickActions deal={deal} viewerEmail={user.email} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <h2 className="border-b border-neutral-200 p-4 font-semibold dark:border-neutral-800">Recent outreach</h2>
        {d.recent.length === 0 ? (
          <p className={`p-4 text-sm ${MUTED}`}>No touches logged yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 text-sm dark:divide-neutral-800">
            {d.recent.map((t) => (
              <li key={t.id} className="flex flex-wrap gap-x-2 px-4 py-2">
                <span className="font-medium">{TOUCH_LABEL[t.kind as TouchKind] ?? t.kind}</span>
                <span>
                  {t.org?.name ?? t.contact?.name ?? t.contact?.email}
                  {t.contact && t.org ? ` (${t.contact.name || t.contact.email})` : ""}
                </span>
                {t.subject && <span className={MUTED}>“{t.subject}”</span>}
                {t.note && <span className={MUTED}>{t.note}</span>}
                <span className={`ml-auto ${MUTED}`}>
                  {t.actor} · {relative(t.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={`${CARD} p-4`}>
      <div className={`text-xs font-medium uppercase tracking-wide ${MUTED}`}>{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className={`text-xs ${MUTED}`}>{sub}</div>
    </div>
  );
}

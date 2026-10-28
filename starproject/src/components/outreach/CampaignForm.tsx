"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteCampaign, saveCampaign } from "@/lib/actions/outreach";
import { parseMoney } from "@/lib/finance/money";
import { CAMPAIGN_KINDS, type CampaignKind } from "@/lib/outreach/constants";

import { titleCase } from "./format";
import { BTN, BTN_PRIMARY, CARD, INPUT, LABEL, MUTED } from "./ui";

type Campaign = {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  goalCents: number | null;
  startsAt: string | null;
  endsAt: string | null;
  thankYouDueAt: string | null;
  notes: string | null;
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** New campaign (collapsed button) or edit an existing one. */
export function CampaignForm({ campaign }: { campaign?: Campaign }) {
  const router = useRouter();
  const [open, setOpen] = useState(!!campaign);
  const [f, setF] = useState({
    name: campaign?.name ?? "",
    kind: (campaign?.kind ?? "crowdfunding") as CampaignKind,
    url: campaign?.url ?? "",
    goal: campaign?.goalCents != null ? String(campaign.goalCents / 100) : "",
    startsAt: day(campaign?.startsAt ?? null),
    endsAt: day(campaign?.endsAt ?? null),
    thankYouDueAt: day(campaign?.thankYouDueAt ?? null),
    notes: campaign?.notes ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((c) => ({ ...c, [k]: v }));
  if (!open)
    return (
      <button className={BTN_PRIMARY} onClick={() => setOpen(true)}>
        + Campaign
      </button>
    );
  // Deadlines are end of day Pacific, near enough: 23:59 UTC-7.
  const eod = (d: string) => (d ? `${d}T23:59:00-07:00` : null);
  return (
    <form
      className={`${CARD} grid gap-3 p-4 sm:grid-cols-4`}
      onSubmit={(e) => {
        e.preventDefault();
        const goalCents = f.goal ? parseMoney(f.goal) : null;
        start(async () => {
          const r = await saveCampaign({
            id: campaign?.id,
            name: f.name,
            kind: f.kind,
            url: f.url,
            goalCents,
            startsAt: f.startsAt ? `${f.startsAt}T00:00:00-07:00` : null,
            endsAt: eod(f.endsAt),
            thankYouDueAt: eod(f.thankYouDueAt),
            notes: f.notes,
          });
          if (!r.ok) return setMsg(r.error);
          setMsg("Saved");
          if (!campaign) {
            setOpen(false);
            router.push(`/outreach/campaigns/${r.id}`);
          } else router.refresh();
        });
      }}
    >
      <label className="sm:col-span-2">
        <span className={LABEL}>Name</span>
        <input className={INPUT} value={f.name} onChange={(e) => set("name", e.target.value)} required placeholder="October 2026 Crowdfunding" />
      </label>
      <label>
        <span className={LABEL}>Kind</span>
        <select className={INPUT} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
          {CAMPAIGN_KINDS.map((k) => (
            <option key={k} value={k}>
              {titleCase(k)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={LABEL}>Goal ($)</span>
        <input className={INPUT} value={f.goal} onChange={(e) => set("goal", e.target.value)} />
      </label>
      <label className="sm:col-span-4">
        <span className={LABEL}>Page URL</span>
        <input className={INPUT} value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://crowdfund.berkeley.edu/…" />
      </label>
      <label>
        <span className={LABEL}>Starts</span>
        <input type="date" className={INPUT} value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
      </label>
      <label>
        <span className={LABEL}>Closes</span>
        <input type="date" className={INPUT} value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
      </label>
      <label>
        <span className={LABEL}>Thank-you due</span>
        <input type="date" className={INPUT} value={f.thankYouDueAt} onChange={(e) => set("thankYouDueAt", e.target.value)} />
      </label>
      <label className="sm:col-span-4">
        <span className={LABEL}>Notes</span>
        <textarea className={`${INPUT} min-h-14`} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="flex items-center gap-2 sm:col-span-4">
        <button className={BTN_PRIMARY} disabled={pending}>
          {campaign ? "Save" : "Create campaign"}
        </button>
        {!campaign && (
          <button type="button" className={BTN} onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
        {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
        {campaign && (
          <button
            type="button"
            className={`${BTN} ml-auto text-red-700 dark:text-red-300`}
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete ${campaign.name} and the gifts recorded under it? People stay.`)) return;
              start(async () => {
                const r = await deleteCampaign(campaign.id);
                if (r.ok) router.push("/outreach/campaigns");
                else setMsg(r.error);
              });
            }}
          >
            Delete campaign
          </button>
        )}
      </div>
    </form>
  );
}

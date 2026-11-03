"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { saveDeal, setDealStage } from "@/lib/actions/outreach";
import { DEAL_STAGES, DEAL_TYPES, DEAL_TYPE_LABEL, STAGE_LABEL, type DealStage, type DealType } from "@/lib/outreach/constants";
import type { DealRow } from "@/lib/outreach/queries";

import { DealQuickActions } from "./DealQuickActions";
import { dollars, relative } from "./format";
import { BTN_PRIMARY, CARD, INPUT, MUTED, PILL, STAGE_TONE, TD, TH, INPUT_INLINE } from "./ui";

export function SponsorsWorkspace({
  deals,
  season,
  seasons,
  initialStage,
  viewerEmail,
}: {
  deals: DealRow[];
  season: string;
  seasons: string[];
  initialStage: string | null;
  viewerEmail: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [stages, setStages] = useState<string[]>(initialStage ? [initialStage] : []);
  const [type, setType] = useState<string>("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [adding, setAdding] = useState(false);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return deals.filter(
      (d) =>
        (!needle ||
          [d.orgName, d.ask, d.theirDeliverables, d.notes, ...d.contacts.map((c) => c.email)]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(needle))) &&
        (!stages.length || stages.includes(d.stage)) &&
        (!type || d.type === type) &&
        (!attentionOnly || d.attention),
    );
  }, [deals, q, stages, type, attentionOnly]);

  const toggleStage = (s: string) => setStages((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${INPUT} max-w-xs`}
          placeholder="Search sponsors, asks, contacts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className={INPUT_INLINE}
          value={season}
          onChange={(e) => router.push(`/outreach/sponsors?season=${encodeURIComponent(e.target.value)}`)}
          aria-label="Season"
        >
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          <option value="all">All seasons</option>
        </select>
        <select className={INPUT_INLINE} value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {DEAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {DEAL_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
          Needs attention
        </label>
        <div className="ml-auto flex gap-2">
          <button className={BTN_PRIMARY} onClick={() => setAdding((a) => !a)}>
            + Sponsor
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {DEAL_STAGES.map((s) => {
          const n = deals.filter((d) => d.stage === s).length;
          const on = stages.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleStage(s)}
              className={`${PILL} ${STAGE_TONE[s]} gap-1 px-2.5 py-1 ${on ? "ring-2 ring-blue-500" : stages.length ? "opacity-50" : ""}`}
            >
              {STAGE_LABEL[s]} <span className="tabular-nums">{n}</span>
            </button>
          );
        })}
        {stages.length > 0 && (
          <button className="text-xs text-blue-600 hover:underline" onClick={() => setStages([])}>
            clear
          </button>
        )}
      </div>

      {adding && <NewDeal season={season === "all" ? seasons[0] : season} onDone={() => setAdding(false)} />}

      <DealTable deals={shown} viewerEmail={viewerEmail} />
      <p className={`text-xs ${MUTED}`}>
        {shown.length} of {deals.length} sponsors · value is what they give or gave, as typed on the deal
      </p>
    </div>
  );
}

function StageSelect({ id, stage }: { id: string; stage: string }) {
  const router = useRouter();
  const [value, setValue] = useState(stage);
  const [pending, start] = useTransition();
  return (
    <select
      value={value}
      disabled={pending}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const s = e.target.value as DealStage;
        setValue(s);
        start(async () => {
          await setDealStage(id, s);
          router.refresh();
        });
      }}
      className={`${PILL} ${STAGE_TONE[value]} cursor-pointer appearance-none border-0 pr-2 outline-none`}
      aria-label="Stage"
    >
      {DEAL_STAGES.map((s) => (
        <option key={s} value={s}>
          {STAGE_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function DealTable({ deals, viewerEmail }: { deals: DealRow[]; viewerEmail: string }) {
  if (!deals.length) return <p className={`${CARD} p-4 text-sm ${MUTED}`}>No sponsors match.</p>;
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full border-collapse text-sm">
        <thead className="border-b border-neutral-200 dark:border-neutral-800">
          <tr>
            <th className={TH}>Sponsor</th>
            <th className={TH}>Stage</th>
            <th className={`${TH} hidden md:table-cell`}>Ask / gives</th>
            <th className={TH}>Last contact</th>
            <th className={TH}>Next</th>
            <th className={TH}></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {deals.map((d) => (
            <tr key={d.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
              <td className={TD}>
                <Link href={`/outreach/sponsors/${d.id}`} className="font-medium hover:text-blue-600">
                  {d.orgName}
                </Link>
                <div className={`text-xs ${MUTED}`}>
                  {DEAL_TYPE_LABEL[d.type as DealType] ?? d.type}
                  {d.renewal ? " · returning" : ""}
                  {d.channel === "form" ? " · web form" : ""}
                </div>
              </td>
              <td className={TD}>
                <StageSelect id={d.id} stage={d.stage} />
              </td>
              <td className={`${TD} hidden max-w-xs md:table-cell`}>
                <div className="line-clamp-2">{d.ask ?? d.theirDeliverables ?? <span className={MUTED}>—</span>}</div>
                {d.valueCents != null && <div className="text-xs font-medium tabular-nums">{dollars(d.valueCents)}</div>}
              </td>
              <td className={`${TD} whitespace-nowrap`}>{relative(d.lastContactAt)}</td>
              <td className={`${TD} whitespace-nowrap`}>
                {d.attention ? (
                  <span className="text-amber-800 dark:text-amber-300">{d.attention.label}</span>
                ) : d.nextFollowUpAt ? (
                  relative(d.nextFollowUpAt)
                ) : (
                  <span className={MUTED}>—</span>
                )}
              </td>
              <td className={`${TD} w-1 whitespace-nowrap text-right`}>
                <DealQuickActions deal={d} viewerEmail={viewerEmail} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewDeal({ season, onDone }: { season: string; onDone: () => void }) {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [type, setType] = useState<DealType>("monetary");
  const [ask, setAsk] = useState("");
  const [renewal, setRenewal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveDeal({ orgName, type, ask, renewal, season });
      if (!r.ok) return setError(r.error);
      onDone();
      router.push(`/outreach/sponsors/${r.id}`);
    });
  };
  return (
    <form onSubmit={submit} className={`${CARD} flex flex-wrap items-end gap-2 p-3`}>
      <label className="min-w-48 flex-1">
        <span className="mb-1 block text-xs font-medium text-neutral-500">Organization</span>
        <input className={INPUT} value={orgName} onChange={(e) => setOrgName(e.target.value)} required autoFocus />
      </label>
      <label>
        <span className="mb-1 block text-xs font-medium text-neutral-500">Type</span>
        <select className={INPUT} value={type} onChange={(e) => setType(e.target.value as DealType)}>
          {DEAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {DEAL_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-64 flex-[2]">
        <span className="mb-1 block text-xs font-medium text-neutral-500">What we&apos;re asking for</span>
        <input className={INPUT} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="2 cameras, $2,000, 50% off parts…" />
      </label>
      <label className="flex items-center gap-1.5 pb-2 text-sm">
        <input type="checkbox" checked={renewal} onChange={(e) => setRenewal(e.target.checked)} /> Returning sponsor
      </label>
      <button className={BTN_PRIMARY} disabled={pending || !orgName.trim()}>
        Add for {season}
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

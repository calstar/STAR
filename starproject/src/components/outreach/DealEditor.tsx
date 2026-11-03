"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteDeal, saveDeal } from "@/lib/actions/outreach";
import { parseMoney } from "@/lib/finance/money";
import { DEAL_STAGES, DEAL_TYPES, DEAL_TYPE_LABEL, STAGE_LABEL, type DealStage, type DealType } from "@/lib/outreach/constants";
import type { DealRow } from "@/lib/outreach/queries";

import { BTN, BTN_PRIMARY, CARD, INPUT, LABEL } from "./ui";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Every field of a deal, saved together. */
export function DealEditor({ deal }: { deal: DealRow }) {
  const router = useRouter();
  const [f, setF] = useState({
    stage: deal.stage as DealStage,
    type: deal.type as DealType,
    ask: deal.ask ?? "",
    theirDeliverables: deal.theirDeliverables ?? "",
    value: deal.valueCents != null ? (deal.valueCents / 100).toFixed(2) : "",
    renewal: deal.renewal,
    nextFollowUpAt: day(deal.nextFollowUpAt),
    lastContactAt: day(deal.lastContactAt),
    notes: deal.notes ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const valueCents = f.value.trim() ? parseMoney(f.value) : null;
    if (f.value.trim() && valueCents == null) return setMsg("Value should be an amount like 3000 or $2,500.");
    start(async () => {
      const r = await saveDeal({
        id: deal.id,
        stage: f.stage,
        type: f.type,
        ask: f.ask,
        theirDeliverables: f.theirDeliverables,
        valueCents,
        renewal: f.renewal,
        nextFollowUpAt: f.nextFollowUpAt || null,
        lastContactAt: f.lastContactAt || null,
        notes: f.notes,
      });
      setMsg(r.ok ? "Saved" : r.error);
      router.refresh();
    });
  };

  return (
    <form onSubmit={save} className={`${CARD} space-y-3 p-4`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className={LABEL}>Stage</span>
          <select className={INPUT} value={f.stage} onChange={(e) => set("stage", e.target.value as DealStage)}>
            {DEAL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL}>Type</span>
          <select className={INPUT} value={f.type} onChange={(e) => set("type", e.target.value as DealType)}>
            {DEAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {DEAL_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL}>Value ($)</span>
          <input className={INPUT} value={f.value} onChange={(e) => set("value", e.target.value)} placeholder="3000" />
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>What we&apos;re asking for</span>
        <input className={INPUT} value={f.ask} onChange={(e) => set("ask", e.target.value)} />
      </label>
      <label className="block">
        <span className={LABEL}>What they give</span>
        <input className={INPUT} value={f.theirDeliverables} onChange={(e) => set("theirDeliverables", e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className={LABEL}>Last contact</span>
          <input type="date" className={INPUT} value={f.lastContactAt} onChange={(e) => set("lastContactAt", e.target.value)} />
        </label>
        <label>
          <span className={LABEL}>Follow up on</span>
          <input type="date" className={INPUT} value={f.nextFollowUpAt} onChange={(e) => set("nextFollowUpAt", e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" checked={f.renewal} onChange={(e) => set("renewal", e.target.checked)} /> Returning sponsor
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea className={`${INPUT} min-h-20`} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY} disabled={pending}>
          Save
        </button>
        {msg && <span className="text-sm text-neutral-500">{msg}</span>}
        <button
          type="button"
          className={`${BTN} ml-auto text-red-700 dark:text-red-300`}
          disabled={pending}
          onClick={() => {
            if (!confirm(`Delete the ${deal.season} deal with ${deal.orgName}? Its touches go too.`)) return;
            start(async () => {
              const r = await deleteDeal(deal.id);
              if (r.ok) router.push("/outreach/sponsors");
              else setMsg(r.error);
            });
          }}
        >
          Delete deal
        </button>
      </div>
    </form>
  );
}

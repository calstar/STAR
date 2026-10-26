"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteTemplate, saveTemplate } from "@/lib/actions/outreach";
import { TEMPLATE_KINDS, type TemplateKind } from "@/lib/outreach/constants";
import { MERGE_FIELDS, render } from "@/lib/outreach/merge";
import type { TemplateRow } from "@/lib/outreach/queries";

import { titleCase } from "./format";
import { BTN, BTN_PRIMARY, BTN_SMALL, CARD, INPUT, LABEL, MUTED } from "./ui";

export function TemplatesWorkspace({
  templates,
  senderName,
  senderEmail,
}: {
  templates: TemplateRow[];
  senderName: string;
  senderEmail: string;
}) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(templates[0]?.id ?? null);
  const cur = templates.find((t) => t.id === id) ?? null;
  const [f, setF] = useState(() => ({
    name: cur?.name ?? "",
    kind: (cur?.kind ?? "sponsor_cold") as TemplateKind,
    subject: cur?.subject ?? "",
    body: cur?.body ?? "",
  }));
  const [renewal, setRenewal] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = (t: TemplateRow | null) => {
    setId(t?.id ?? null);
    setF({ name: t?.name ?? "", kind: (t?.kind ?? "sponsor_cold") as TemplateKind, subject: t?.subject ?? "", body: t?.body ?? "" });
    setMsg(null);
  };
  const sample = {
    first_name: "Cindy",
    last_name: "Pederson",
    full_name: "Cindy Pederson",
    email: "dana@example.com",
    org: "Mechanics Bank",
    ask: "renewing your $8,330 outreach scholarship",
    their_deliverables: "$8,330",
    our_deliverables: "logo on the vehicle and website",
    project: "LE4",
    season: "2026–27",
    renewal,
    last_gift: "$150.00",
    referrer: "Ada L.",
    campaign_url: "https://crowdfund.berkeley.edu/star",
    sender_name: senderName,
    sender_first_name: senderName.split(/\s+/)[0],
    sender_email: senderEmail,
  };
  const subj = render(f.subject, sample);
  const body = render(f.body, sample);

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1fr)]">
      <aside className={`${CARD} p-3`}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Templates</h3>
          <button className={BTN_SMALL} onClick={() => pick(null)}>
            + New
          </button>
        </div>
        <ul className="space-y-0.5">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => pick(t)}
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${t.id === id ? "bg-blue-50 font-medium dark:bg-blue-950" : ""}`}
              >
                <div className="truncate">{t.name}</div>
                <div className={`text-xs ${MUTED}`}>
                  {titleCase(t.kind)} · used {t.uses}×
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <form
        className={`${CARD} space-y-3 p-4`}
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await saveTemplate({ id: id ?? undefined, ...f });
            if (!r.ok) return setMsg(r.error);
            setId(r.id);
            setMsg("Saved");
            router.refresh();
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={LABEL}>Name</span>
            <input className={INPUT} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            <span className={LABEL}>Kind</span>
            <select className={INPUT} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TemplateKind })}>
              {TEMPLATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className={LABEL}>Subject</span>
          <input className={INPUT} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required />
        </label>
        <label className="block">
          <span className={LABEL}>Body</span>
          <textarea className={`${INPUT} min-h-80 font-mono text-[13px]`} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button className={BTN_PRIMARY} disabled={pending}>
            Save template
          </button>
          {id && (
            <>
              <Link className={BTN} href={`/outreach/compose?template=${id}`}>
                Use in Compose →
              </Link>
              <button
                type="button"
                className={`${BTN} text-red-700`}
                disabled={pending}
                onClick={() =>
                  confirm("Delete this template?") &&
                  start(async () => {
                    await deleteTemplate(id);
                    pick(null);
                    router.refresh();
                  })
                }
              >
                Delete
              </button>
            </>
          )}
          {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
        </div>
        <details className="text-xs">
          <summary className={`cursor-pointer ${MUTED}`}>Merge fields</summary>
          <ul className="mt-1 space-y-0.5">
            {MERGE_FIELDS.map((m) => (
              <li key={m.name}>
                <code className="text-blue-700 dark:text-blue-300">{`{{${m.name}}}`}</code> <span className={MUTED}>{m.help}</span>
              </li>
            ))}
          </ul>
        </details>
      </form>
      <div className={`${CARD} p-4`}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Preview (sample sponsor)</h3>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={renewal} onChange={(e) => setRenewal(e.target.checked)} /> returning sponsor
          </label>
        </div>
        <div className="font-medium">{subj.text}</div>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{body.text}</pre>
        {[...subj.missing, ...body.missing].length > 0 && (
          <p className="mt-2 text-xs text-amber-700">Unknown fields: {[...new Set([...subj.missing, ...body.missing])].join(", ")}</p>
        )}
      </div>
    </div>
  );
}

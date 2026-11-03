"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { logTouches } from "@/lib/actions/outreach";
import { gmailComposeUrl } from "@/lib/outreach/compose";
import { DEAL_STAGES, STAGE_LABEL, seasonOf } from "@/lib/outreach/constants";
import { MERGE_FIELDS, render } from "@/lib/outreach/merge";
import type { ComposeRow, ComposeSource, TemplateRow } from "@/lib/outreach/queries";

import { CopyButton } from "./CopyButton";
import { relative } from "./format";
import { BTN, BTN_PRIMARY, BTN_SMALL, CARD, INPUT, LABEL, MUTED, TAG, INPUT_INLINE } from "./ui";

type SP = { list?: string; stages?: string; season?: string; deal?: string; contact?: string; template?: string; campaign?: string };

export function ComposeWorkspace({
  params,
  source,
  rows,
  lists,
  templates,
  campaigns,
  seasons,
  sent,
  viewerEmail,
}: {
  params: SP;
  source: ComposeSource | null;
  rows: ComposeRow[];
  lists: { id: string; name: string; count: number }[];
  templates: TemplateRow[];
  campaigns: { id: string; name: string }[];
  seasons: string[];
  sent: { contactId: string | null; dealId: string | null; at: string }[];
  viewerEmail: string;
}) {
  const router = useRouter();
  const tpl = templates.find((t) => t.id === params.template) ?? null;
  const [subject, setSubject] = useState(tpl?.subject ?? "");
  const [body, setBody] = useState(tpl?.body ?? "");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [followUp, setFollowUp] = useState("10");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [stagePick, setStagePick] = useState<string[]>(params.stages ? params.stages.split(",") : ["prospect"]);
  const [seasonPick, setSeasonPick] = useState(params.season ?? seasonOf(new Date()));

  const go = (next: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...next })) if (v) p.set(k, v);
    router.push(`/outreach/compose?${p}`);
  };
  const setSource = (next: Partial<SP>) => go({ list: undefined, stages: undefined, season: undefined, deal: undefined, contact: undefined, ...next });

  const sentAt = (r: ComposeRow) =>
    sent.find((s) => (r.dealId && s.dealId === r.dealId && !r.contactId) || (r.contactId && s.contactId === r.contactId))?.at ?? null;

  const rendered = useMemo(
    () =>
      rows.map((r) => {
        const s = render(subject, r.vars);
        const b = render(body, r.vars);
        return { row: r, subject: s.text, body: b.text, missing: [...new Set([...s.missing, ...b.missing])] };
      }),
    [rows, subject, body],
  );
  const isDone = (key: string) => done.has(key);
  const nextUnsent = rendered.find((x) => x.row.to.length && !isDone(x.row.key) && !opened.has(x.row.key) && !sentAt(x.row));

  const open = (x: (typeof rendered)[number]) => {
    window.open(gmailComposeUrl({ to: x.row.to, subject: x.subject, body: x.body, authuser: viewerEmail }), "_blank", "noopener");
    setOpened((o) => new Set(o).add(x.row.key));
  };
  const markSent = (xs: typeof rendered) =>
    start(async () => {
      const r = await logTouches(
        xs.map((x) => ({
          kind: "email_sent" as const,
          contactId: x.row.contactId,
          dealId: x.row.dealId,
          orgId: x.row.orgId,
          templateId: tpl?.id ?? null,
          campaignId: params.campaign ?? null,
          subject: x.subject,
          followUpDays: x.row.dealId ? (followUp ? Number(followUp) : null) : undefined,
        })),
      );
      if (!r.ok) return setMsg(r.error);
      setDone((d) => {
        const n = new Set(d);
        for (const x of xs) n.add(x.row.key);
        return n;
      });
      setMsg(`Logged ${r.logged} as sent`);
      router.refresh();
    });

  const openedNotLogged = rendered.filter((x) => opened.has(x.row.key) && !isDone(x.row.key));
  const sourceLabel =
    source?.kind === "list"
      ? `List: ${lists.find((l) => l.id === source.listId)?.name ?? "?"}`
      : source?.kind === "deals"
        ? `Sponsors in ${source.stages.map((s) => STAGE_LABEL[s as keyof typeof STAGE_LABEL] ?? s).join(", ")} (${source.season})`
        : source?.kind === "deal"
          ? `One sponsor: ${rows[0]?.label ?? ""}`
          : source?.kind === "contact"
            ? `One person: ${rows[0]?.label ?? ""}`
            : null;

  return (
    <div className="space-y-4">
      <div className={`${CARD} grid gap-4 p-4 md:grid-cols-3`}>
        <div>
          <span className={LABEL}>1. Who</span>
          <select className={INPUT} value={params.list ?? ""} onChange={(e) => e.target.value && setSource({ list: e.target.value })}>
            <option value="">A saved list…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.count})
              </option>
            ))}
          </select>
          <div className="mt-2 text-xs font-medium text-neutral-500">or sponsors in stage</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {DEAL_STAGES.map((s) => (
              <button
                key={s}
                type="button"
                className={`${TAG} ${stagePick.includes(s) ? "bg-blue-100 text-blue-800 ring-1 ring-blue-500 dark:bg-blue-950 dark:text-blue-200" : ""}`}
                onClick={() => setStagePick((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]))}
              >
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-1">
            <select className={INPUT_INLINE} value={seasonPick} onChange={(e) => setSeasonPick(e.target.value)}>
              {seasons.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button className={BTN_SMALL} disabled={!stagePick.length} onClick={() => setSource({ stages: stagePick.join(","), season: seasonPick })}>
              Use these sponsors
            </button>
          </div>
          {sourceLabel && <p className="mt-2 text-sm font-medium">{sourceLabel} · {rows.length} emails</p>}
        </div>
        <div>
          <span className={LABEL}>2. Template</span>
          <select className={INPUT} value={params.template ?? ""} onChange={(e) => go({ template: e.target.value || undefined })}>
            <option value="">Write from scratch</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <p className={`mt-1 text-xs ${MUTED}`}>
            Edits here apply to this merge only. <Link className="text-blue-600 hover:underline" href="/outreach/templates">Manage templates</Link>
          </p>
        </div>
        <div>
          <span className={LABEL}>3. Campaign (optional)</span>
          <select className={INPUT} value={params.campaign ?? ""} onChange={(e) => go({ campaign: e.target.value || undefined })}>
            <option value="">None</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="mt-2 block">
            <span className={LABEL}>After sending, follow up sponsors in (days)</span>
            <input className={INPUT} value={followUp} onChange={(e) => setFollowUp(e.target.value.replace(/\D/g, ""))} placeholder="no reminder" />
          </label>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className={`${CARD} space-y-3 p-4`}>
          <label className="block">
            <span className={LABEL}>Subject</span>
            <input className={INPUT} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="block">
            <span className={LABEL}>Body</span>
            <textarea className={`${INPUT} min-h-64 font-mono text-[13px]`} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
        <div className={`${CARD} p-3 text-xs`}>
          <h3 className="mb-1 text-sm font-semibold">Merge fields</h3>
          <p className={`mb-2 ${MUTED}`}>
            <code>{"{{first_name|there}}"}</code> falls back; <code>{"{{#renewal}}…{{/renewal}}"}</code> shows only for returning sponsors,{" "}
            <code>{"{{^renewal}}…{{/renewal}}"}</code> only for new ones.
          </p>
          <ul className="space-y-0.5">
            {MERGE_FIELDS.map((f) => (
              <li key={f.name}>
                <button className="font-mono text-blue-700 hover:underline dark:text-blue-300" onClick={() => setBody((b) => `${b}{{${f.name}}}`)}>
                  {`{{${f.name}}}`}
                </button>{" "}
                <span className={MUTED}>{f.help}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {source && (
        <div className={CARD}>
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3 dark:border-neutral-800">
            <h3 className="font-semibold">
              {rows.length} emails · {done.size + rendered.filter((x) => !done.has(x.row.key) && sentAt(x.row)).length} sent
            </h3>
            <button className={BTN_PRIMARY} disabled={!nextUnsent || !subject} onClick={() => nextUnsent && open(nextUnsent)}>
              Open next in Gmail →
            </button>
            {openedNotLogged.length > 0 && (
              <button className={BTN} disabled={pending} onClick={() => markSent(openedNotLogged)}>
                Mark the {openedNotLogged.length} I opened as sent
              </button>
            )}
            {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
            <span className={`w-full text-xs ${MUTED}`}>
              Each email opens as a filled-in Gmail draft in {viewerEmail}. Review it, attach the sponsorship packet if
              the email mentions it (links can&apos;t carry attachments), send, then mark it sent here so the follow-up clock starts.
            </span>
          </div>
          {rows.length === 0 && <p className={`p-4 text-sm ${MUTED}`}>Nobody to write to (no addresses, or all do-not-contact).</p>}
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rendered.map((x) => {
              const already = sentAt(x.row);
              const finished = isDone(x.row.key);
              return (
                <li key={x.row.key} className={`px-3 py-2 text-sm ${finished ? "bg-green-50 dark:bg-green-950/30" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="font-medium hover:text-blue-600" onClick={() => setExpanded(expanded === x.row.key ? null : x.row.key)}>
                      {x.row.label}
                    </button>
                    <span className={`truncate ${MUTED}`}>{x.row.to.join(", ") || "no address"}</span>
                    {x.missing.length > 0 && <span className="text-xs text-amber-700 dark:text-amber-300">missing: {x.missing.join(", ")}</span>}
                    {already && !finished && <span className="text-xs text-green-700">sent {relative(already)}</span>}
                    {finished && <span className="text-xs text-green-700">✓ logged</span>}
                    {opened.has(x.row.key) && !finished && <span className="text-xs text-blue-700">opened</span>}
                    <span className="ml-auto flex gap-1">
                      <button className={BTN_SMALL} disabled={!x.row.to.length} onClick={() => open(x)}>
                        ✉ Gmail
                      </button>
                      <CopyButton label="Copy body" text={x.body} className={BTN_SMALL} />
                      <button className={BTN_SMALL} disabled={pending || finished} onClick={() => markSent([x])}>
                        ✓ Sent
                      </button>
                    </span>
                  </div>
                  {expanded === x.row.key && (
                    <div className="mt-2 rounded bg-neutral-50 p-3 dark:bg-neutral-800">
                      <div className="font-medium">{x.subject}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-sans">{x.body}</pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteTouch, logTouch } from "@/lib/actions/outreach";
import { TOUCH_KINDS, TOUCH_LABEL, type TouchKind } from "@/lib/outreach/constants";
import type { TouchRow } from "@/lib/outreach/queries";

import { relative, shortDate } from "./format";
import { BTN_PRIMARY, BTN_SMALL, CARD, INPUT, LABEL, MUTED } from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

/** Log an interaction, and the timeline of every one so far. */
export function TouchLog({
  touches,
  target,
  contacts = [],
  templates = [],
  campaigns = [],
  defaultKind = "email_sent",
}: {
  touches: TouchRow[];
  target: { dealId?: string; orgId?: string; contactId?: string };
  contacts?: { id: string; email: string | null; name: string }[];
  templates?: { id: string; name: string }[];
  campaigns?: { id: string; name: string }[];
  defaultKind?: TouchKind;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<TouchKind>(defaultKind);
  const [contactId, setContactId] = useState(target.contactId ?? "");
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [threadUrl, setThreadUrl] = useState("");
  const [at, setAt] = useState(today());
  const [followUp, setFollowUp] = useState("10");
  const [templateId, setTemplateId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const outbound = kind === "email_sent" || kind === "form_submitted" || kind === "call" || kind === "meeting";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await logTouch({
        kind,
        dealId: target.dealId,
        orgId: target.orgId,
        contactId: contactId || target.contactId || null,
        subject,
        note,
        threadUrl,
        at: at === today() ? new Date().toISOString() : `${at}T12:00:00Z`,
        followUpDays: target.dealId && (outbound || kind === "reply") ? (followUp ? Number(followUp) : null) : undefined,
        templateId: templateId || null,
        campaignId: campaignId || null,
      });
      if (!r.ok) return setMsg(r.error);
      setSubject("");
      setNote("");
      setThreadUrl("");
      setMsg("Logged");
      router.refresh();
    });
  };

  return (
    <div className={CARD}>
      <form onSubmit={submit} className="space-y-3 border-b border-neutral-200 p-4 dark:border-neutral-800">
        <h3 className="font-semibold">Log a touch</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={LABEL}>What happened</span>
            <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as TouchKind)}>
              {TOUCH_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TOUCH_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>When</span>
            <input type="date" className={INPUT} value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          {target.dealId && (outbound || kind === "reply") ? (
            <label>
              <span className={LABEL}>Follow up in (days)</span>
              <input className={INPUT} value={followUp} onChange={(e) => setFollowUp(e.target.value.replace(/\D/g, ""))} placeholder="none" />
            </label>
          ) : (
            <span />
          )}
        </div>
        {contacts.length > 0 && (
          <label className="block">
            <span className={LABEL}>With</span>
            <select className={INPUT} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">The organization</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ? `${c.name} <${c.email}>` : c.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={LABEL}>Subject</span>
            <input className={INPUT} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Gmail thread link</span>
            <input className={INPUT} value={threadUrl} onChange={(e) => setThreadUrl(e.target.value)} placeholder="https://mail.google.com/…" />
          </label>
        </div>
        {(templates.length > 0 || campaigns.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {templates.length > 0 && (
              <label>
                <span className={LABEL}>Template used</span>
                <select className={INPUT} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">None</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {campaigns.length > 0 && (
              <label>
                <span className={LABEL}>Campaign</span>
                <select className={INPUT} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  <option value="">None</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <label className="block">
          <span className={LABEL}>Note</span>
          <textarea className={`${INPUT} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button className={BTN_PRIMARY} disabled={pending}>
            Log
          </button>
          {msg && <span className={`text-sm ${MUTED}`}>{msg}</span>}
        </div>
      </form>
      <TouchTimeline touches={touches} />
    </div>
  );
}

export function TouchTimeline({ touches }: { touches: TouchRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!touches.length) return <p className={`p-4 text-sm ${MUTED}`}>No history yet.</p>;
  return (
    <ol className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {touches.map((t) => (
        <li key={t.id} className="group px-4 py-2.5 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{TOUCH_LABEL[t.kind as TouchKind] ?? t.kind}</span>
            {t.contact && <span>{t.contact.name || t.contact.email}</span>}
            {t.subject && <span className={MUTED}>“{t.subject}”</span>}
            {t.template && <span className={`text-xs ${MUTED}`}>template: {t.template}</span>}
            {t.campaign && <span className={`text-xs ${MUTED}`}>{t.campaign}</span>}
            <span className={`ml-auto text-xs ${MUTED}`} title={shortDate(t.at)}>
              {t.actor} · {relative(t.at)}
            </span>
            <button
              className={`${BTN_SMALL} invisible group-hover:visible`}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  if (!confirm("Delete this entry?")) return;
                  await deleteTouch(t.id);
                  router.refresh();
                })
              }
              aria-label="Delete entry"
            >
              ✕
            </button>
          </div>
          {t.note && <p className="mt-0.5 whitespace-pre-wrap text-neutral-600 dark:text-neutral-300">{t.note}</p>}
          {t.threadUrl && (
            <a className="text-xs text-blue-600 hover:underline" href={t.threadUrl} target="_blank" rel="noreferrer">
              Open thread ↗
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { logTouch, scheduleFollowUp } from "@/lib/actions/outreach";
import { gmailComposeUrl } from "@/lib/outreach/compose";

import { BTN_SMALL } from "./ui";

export type QuickDeal = {
  id: string;
  orgId: string;
  orgName: string;
  channel: string;
  formUrl: string | null;
  contacts: { email: string | null; bounced?: boolean }[];
};

/**
 * The one-click moves on a sponsor: write to them in Gmail, open their form,
 * say it went out (follow up in 10 days), say they replied, or push the
 * reminder a week.
 */
export function DealQuickActions({ deal, viewerEmail }: { deal: QuickDeal; viewerEmail: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? done : (r.error ?? "Failed"));
      router.refresh();
    });
  const to = deal.contacts.filter((c) => !c.bounced).map((c) => c.email).filter((e): e is string => !!e);

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {to.length > 0 && (
        <a
          className={BTN_SMALL}
          href={gmailComposeUrl({ to, authuser: viewerEmail })}
          target="_blank"
          rel="noreferrer"
          title={`Write to ${to.join(", ")} in Gmail`}
        >
          ✉ Gmail
        </a>
      )}
      {deal.formUrl && (
        <a className={BTN_SMALL} href={deal.formUrl} target="_blank" rel="noreferrer">
          ↗ Form
        </a>
      )}
      <button
        className={BTN_SMALL}
        disabled={pending}
        onClick={() =>
          run(
            () =>
              logTouch({
                kind: deal.channel === "form" ? "form_submitted" : "email_sent",
                dealId: deal.id,
                orgId: deal.orgId,
                followUpDays: 10,
              }),
            "Logged · follow up in 10 days",
          )
        }
        title="Record that it went out today; reminds you in 10 days"
      >
        ✓ {deal.channel === "form" ? "Submitted" : "Sent"}
      </button>
      <button
        className={BTN_SMALL}
        disabled={pending}
        onClick={() => run(() => logTouch({ kind: "reply", dealId: deal.id, orgId: deal.orgId }), "Reply logged")}
      >
        ↩ Replied
      </button>
      <button
        className={BTN_SMALL}
        disabled={pending}
        onClick={() => run(() => scheduleFollowUp(deal.id, 7), "Snoozed a week")}
      >
        ⏰ +7d
      </button>
      {msg && <span className="text-xs text-neutral-500">{msg}</span>}
    </div>
  );
}

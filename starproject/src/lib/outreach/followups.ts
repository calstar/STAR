// What the outreach dashboard puts in front of you. The failure it exists for:
// forty renewal emails sent in two days, most never answered, and nothing that
// says "it's been ten days, nudge Boeing". Pure: rules over plain rows.

import { AWAITING_REPLY, CLOSED_STAGES, DEFAULT_FOLLOW_UP_DAYS, type DealStage } from "./constants";

const DAY = 86_400_000;

export type DealForAttention = {
  stage: string;
  renewal: boolean;
  lastContactAt: Date | null;
  nextFollowUpAt: Date | null;
  /** Their most recent reply, and our most recent unsent draft (from touches). */
  lastReplyAt?: Date | null;
  lastDraftAt?: Date | null;
  /** Every address we have at the org bounced (and there is at least one). */
  allBounced?: boolean;
  org: { channel: string; formUrl: string | null };
};

export type Attention = {
  kind: "bounced" | "follow_up_due" | "their_move" | "no_reply" | "draft_unsent" | "form_to_submit" | "renewal_not_started";
  /** One line for the queue: "Follow-up was due 3 days ago". */
  label: string;
  /** How urgent, for sorting: bigger first. Days overdue, roughly. */
  weight: number;
};

const days = (ms: number) => Math.floor(ms / DAY);
const ago = (n: number) => (n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`);

/** Why this deal needs someone today, or null. */
export function dealAttention(d: DealForAttention, now: Date, quietDays = DEFAULT_FOLLOW_UP_DAYS): Attention | null {
  const stage = d.stage as DealStage;
  if (CLOSED_STAGES.includes(stage) || stage === "committed" || stage === "received") {
    // Money promised or in hand: only a scheduled follow-up (send the thank-you,
    // chase the check) brings it back.
    if (d.nextFollowUpAt && d.nextFollowUpAt <= now && !CLOSED_STAGES.includes(stage)) {
      const n = days(now.getTime() - d.nextFollowUpAt.getTime());
      return { kind: "follow_up_due", label: `Follow-up was due ${ago(n)}`, weight: 100 + n };
    }
    return null;
  }
  // Nobody got it: a follow-up would bounce too.
  if (d.allBounced && stage !== "prospect") {
    return { kind: "bounced", label: "Every address bounced; find a new contact", weight: 200 };
  }
  if (d.nextFollowUpAt && d.nextFollowUpAt <= now) {
    const n = days(now.getTime() - d.nextFollowUpAt.getTime());
    return { kind: "follow_up_due", label: `Follow-up was due ${ago(n)}`, weight: 100 + n };
  }
  // They wrote back after our last email: the ball is in our court.
  if (d.lastReplyAt && (!d.lastContactAt || d.lastReplyAt > d.lastContactAt)) {
    const n = days(now.getTime() - d.lastReplyAt.getTime());
    return { kind: "their_move", label: `They replied ${ago(n)}; your move`, weight: 90 + n };
  }
  if (AWAITING_REPLY.includes(stage) && !d.nextFollowUpAt && d.lastContactAt) {
    const n = days(now.getTime() - d.lastContactAt.getTime());
    if (n >= quietDays) return { kind: "no_reply", label: `No reply since ${ago(n)}`, weight: 50 + n };
  }
  if (stage === "drafting" && d.org.channel !== "form" && d.lastDraftAt && (!d.lastContactAt || d.lastDraftAt > d.lastContactAt)) {
    const n = days(now.getTime() - d.lastDraftAt.getTime());
    return { kind: "draft_unsent", label: `Draft written ${ago(n)}, never sent`, weight: 40 + n };
  }
  if ((stage === "prospect" || stage === "drafting") && d.org.channel === "form") {
    return { kind: "form_to_submit", label: "Request goes in through their web form", weight: 30 };
  }
  if (stage === "prospect" && d.renewal && !d.lastContactAt) {
    return { kind: "renewal_not_started", label: "Returning sponsor, not asked yet this season", weight: 20 };
  }
  return null;
}

export type CampaignForAttention = { name: string; endsAt: Date | null; thankYouDueAt: Date | null };

/** Deadlines within `horizonDays`, soonest first. */
export function campaignMilestones(c: CampaignForAttention, now: Date, horizonDays = 21) {
  const out: { label: string; at: Date; daysLeft: number }[] = [];
  const consider = (at: Date | null, label: string) => {
    if (!at) return;
    const left = Math.ceil((at.getTime() - now.getTime()) / DAY);
    if (left >= 0 && left <= horizonDays) out.push({ label, at, daysLeft: left });
  };
  consider(c.endsAt, `${c.name} closes`);
  consider(c.thankYouDueAt, `${c.name} thank-you update due`);
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** "in 5 days" / "today" / "tomorrow". */
export function daysLeftLabel(n: number): string {
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}

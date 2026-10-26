import { describe, expect, it } from "vitest";

import { addDays, campaignMilestones, dealAttention, type DealForAttention } from "./followups";

const now = new Date("2026-10-26T12:00:00Z");
const deal = (o: Partial<DealForAttention> = {}): DealForAttention => ({
  stage: "contacted",
  renewal: false,
  lastContactAt: null,
  nextFollowUpAt: null,
  org: { channel: "email", formUrl: null },
  ...o,
});

describe("dealAttention", () => {
  it("a scheduled follow-up that has come due wins", () => {
    const a = dealAttention(deal({ nextFollowUpAt: addDays(now, -3) }), now);
    expect(a).toMatchObject({ kind: "follow_up_due", label: "Follow-up was due 3 days ago" });
  });
  it("a scheduled follow-up in the future keeps it quiet", () => {
    expect(dealAttention(deal({ lastContactAt: addDays(now, -30), nextFollowUpAt: addDays(now, 2) }), now)).toBeNull();
  });
  it("contacted and quiet past the threshold: no reply", () => {
    expect(dealAttention(deal({ lastContactAt: addDays(now, -9) }), now)).toBeNull();
    expect(dealAttention(deal({ lastContactAt: addDays(now, -14) }), now)).toMatchObject({
      kind: "no_reply",
      label: "No reply since 14 days ago",
    });
  });
  it("forms and unstarted renewals surface for prospects", () => {
    expect(dealAttention(deal({ stage: "prospect", org: { channel: "form", formUrl: "https://x" } }), now)?.kind).toBe(
      "form_to_submit",
    );
    expect(dealAttention(deal({ stage: "prospect", renewal: true }), now)?.kind).toBe("renewal_not_started");
    expect(dealAttention(deal({ stage: "prospect" }), now)).toBeNull();
  });
  it("closed deals never nag, committed ones only on a scheduled follow-up", () => {
    expect(dealAttention(deal({ stage: "declined", nextFollowUpAt: addDays(now, -1) }), now)).toBeNull();
    expect(dealAttention(deal({ stage: "committed", lastContactAt: addDays(now, -40) }), now)).toBeNull();
    expect(dealAttention(deal({ stage: "committed", nextFollowUpAt: addDays(now, -1) }), now)?.kind).toBe(
      "follow_up_due",
    );
  });
  it("urgency orders follow-ups above silence above forms", () => {
    const due = dealAttention(deal({ nextFollowUpAt: addDays(now, -1) }), now)!.weight;
    const quiet = dealAttention(deal({ lastContactAt: addDays(now, -20) }), now)!.weight;
    const form = dealAttention(deal({ stage: "prospect", org: { channel: "form", formUrl: null } }), now)!.weight;
    expect(due).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(form);
  });
});

describe("replies and drafts", () => {
  it("a reply after our last email is our move, ahead of silence", () => {
    const a = dealAttention(deal({ stage: "in_talks", lastContactAt: addDays(now, -13), lastReplyAt: addDays(now, -12) }), now);
    expect(a).toMatchObject({ kind: "their_move", label: "They replied 12 days ago; your move" });
    // We answered since: back to waiting on them.
    const b = dealAttention(deal({ stage: "in_talks", lastContactAt: addDays(now, -11), lastReplyAt: addDays(now, -12) }), now);
    expect(b?.kind).toBe("no_reply");
  });
  it("a written draft that never went out", () => {
    expect(dealAttention(deal({ stage: "drafting", lastDraftAt: addDays(now, -14) }), now)).toMatchObject({
      kind: "draft_unsent",
      label: "Draft written 14 days ago, never sent",
    });
    expect(dealAttention(deal({ stage: "drafting", lastDraftAt: addDays(now, -14), lastContactAt: addDays(now, -2) }), now)).toBeNull();
  });
});

describe("bounces", () => {
  it("a sponsor whose every address bounced comes first, whatever else is due", () => {
    const a = dealAttention(deal({ allBounced: true, nextFollowUpAt: addDays(now, -5), lastContactAt: addDays(now, -12) }), now);
    expect(a).toMatchObject({ kind: "bounced" });
    expect(a!.weight).toBeGreaterThan(dealAttention(deal({ nextFollowUpAt: addDays(now, -60) }), now)!.weight);
    expect(dealAttention(deal({ allBounced: false, lastContactAt: addDays(now, -2) }), now)).toBeNull();
  });
});

describe("campaignMilestones", () => {
  it("lists deadlines inside the horizon, soonest first", () => {
    const m = campaignMilestones(
      {
        name: "October 2026",
        endsAt: new Date("2026-10-31T23:59:00Z"),
        thankYouDueAt: new Date("2026-11-04T23:59:00Z"),
      },
      now,
    );
    expect(m.map((x) => [x.label, x.daysLeft])).toEqual([
      ["October 2026 closes", 6],
      ["October 2026 thank-you update due", 10],
    ]);
    expect(campaignMilestones({ name: "x", endsAt: addDays(now, -1), thankYouDueAt: null }, now)).toEqual([]);
  });
});

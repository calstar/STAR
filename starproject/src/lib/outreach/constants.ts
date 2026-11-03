// The vocabularies the outreach models store as plain strings (prisma/schema.prisma,
// "Outreach CRM"). The lists here are the only values the actions accept, so
// adding a stage or kind is a one-line change with no migration.

export const ORG_KINDS = ["company", "foundation", "campus", "school", "club", "vendor", "event"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const CHANNELS = ["email", "form", "linkedin", "phone"] as const;
export type Channel = (typeof CHANNELS)[number];

export const AFFILIATIONS = ["alumni", "family", "friend", "faculty", "student", "industry", "other"] as const;
export type Affiliation = (typeof AFFILIATIONS)[number];

export const DEAL_TYPES = ["monetary", "in_kind", "discount", "services"] as const;
export type DealType = (typeof DEAL_TYPES)[number];

/** In pipeline order; the last two are the ways a deal leaves without money. */
export const DEAL_STAGES = [
  "prospect",
  "drafting",
  "contacted",
  "in_talks",
  "committed",
  "received",
  "thanked",
  "declined",
  "ghosted",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Stages where the ball is in their court: a follow-up is due if they go quiet. */
export const AWAITING_REPLY: readonly DealStage[] = ["contacted", "in_talks"];
/** Stages that count toward "committed" money on the dashboard. */
export const WON_STAGES: readonly DealStage[] = ["committed", "received", "thanked"];
export const CLOSED_STAGES: readonly DealStage[] = ["thanked", "declined", "ghosted"];

export const STAGE_LABEL: Record<DealStage, string> = {
  prospect: "Prospect",
  drafting: "Drafting",
  contacted: "Contacted",
  in_talks: "In talks",
  committed: "Committed",
  received: "Received",
  thanked: "Thanked",
  declined: "Declined",
  ghosted: "Ghosted",
};

export const DEAL_TYPE_LABEL: Record<DealType, string> = {
  monetary: "Monetary",
  in_kind: "In-kind",
  discount: "Discount",
  services: "Services / licenses",
};

export const CAMPAIGN_KINDS = ["crowdfunding", "newsletter", "event", "sponsor_drive"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const TOUCH_KINDS = [
  "email_sent",
  "email_drafted",
  "reply",
  "form_submitted",
  "call",
  "meeting",
  "note",
] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export const TOUCH_LABEL: Record<TouchKind, string> = {
  email_sent: "Email sent",
  email_drafted: "Email drafted",
  reply: "They replied",
  form_submitted: "Form submitted",
  call: "Call",
  meeting: "Meeting",
  note: "Note",
};

/** Touches that are us reaching out (they restart the follow-up clock). */
export const OUTBOUND_TOUCHES: readonly TouchKind[] = ["email_sent", "form_submitted", "call", "meeting"];

export const TEMPLATE_KINDS = [
  "sponsor_cold",
  "sponsor_renewal",
  "sponsor_followup",
  "sponsor_thanks",
  "crowdfunding_ask",
  "crowdfunding_thanks",
  "event",
  "other",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const PERK_STATUSES = ["none", "pending", "sent"] as const;

/** The sponsorship season a date falls in: Aug–Jul, "2026–27". */
export function seasonOf(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 7 ? y : y - 1;
  return `${start}–${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Days a contacted sponsor gets before the dashboard says "follow up". */
export const DEFAULT_FOLLOW_UP_DAYS = 10;

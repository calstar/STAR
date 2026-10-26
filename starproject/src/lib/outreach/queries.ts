// Reads for the /outreach pages and MCP tools. Server-only (Prisma). These rows
// hold donors' contact details and gifts, so every exported reader checks the
// viewer is an admin itself (adminOnly). The layout's gate is not enough: Next
// renders a page alongside its layout, and a page's data reaches the browser
// even when the layout shows the "admins only" panel instead of it.

import type { Prisma } from "@prisma/client";
import { cache } from "react";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

import { WON_STAGES, seasonOf, type DealStage } from "./constants";
import { campaignMilestones, dealAttention, type Attention } from "./followups";
import { CONTACT_PAGE } from "./page-size";
import { segmentWhere, type SegmentFilter } from "./segments";

export const outreachViewer = cache(async () => {
  const user = await getCurrentDbUser();
  return { user, admin: await isAdmin(user.email) };
});

/** Throws unless the viewer is an admin. Once per request (cached). */
async function adminOnly(): Promise<void> {
  if (!(await outreachViewer()).admin) throw new Error("Forbidden: admins only");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const personName = (c: { firstName: string | null; lastName: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ");

// ---- deals -----------------------------------------------------------------

const DEAL_INCLUDE = {
  org: {
    include: {
      contacts: {
        where: { doNotContact: false },
        select: { id: true, email: true, firstName: true, lastName: true, title: true, bounced: true },
        orderBy: { createdAt: "asc" },
      },
    },
  },
  _count: { select: { touches: true } },
  // The newest reply and the newest unsent draft, for the attention rules.
  touches: {
    where: { kind: { in: ["reply", "email_drafted"] } },
    select: { kind: true, at: true },
    orderBy: { at: "desc" },
    take: 20,
  },
} satisfies Prisma.OutreachDealInclude;

type DealWithRefs = Prisma.OutreachDealGetPayload<{ include: typeof DEAL_INCLUDE }>;

export type DealRow = {
  id: string;
  orgId: string;
  orgName: string;
  orgKind: string;
  channel: string;
  formUrl: string | null;
  website: string | null;
  season: string;
  type: string;
  stage: string;
  ask: string | null;
  theirDeliverables: string | null;
  valueCents: number | null;
  renewal: boolean;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  notes: string | null;
  contacts: { id: string; email: string | null; name: string; title: string | null; bounced: boolean }[];
  touchCount: number;
  attention: Attention | null;
};

function toDealRow(d: DealWithRefs, now: Date): DealRow {
  return {
    id: d.id,
    orgId: d.orgId,
    orgName: d.org.name,
    orgKind: d.org.kind,
    channel: d.org.channel,
    formUrl: d.org.formUrl,
    website: d.org.website,
    season: d.season,
    type: d.type,
    stage: d.stage,
    ask: d.ask,
    theirDeliverables: d.theirDeliverables,
    valueCents: d.valueCents,
    renewal: d.renewal,
    lastContactAt: iso(d.lastContactAt),
    nextFollowUpAt: iso(d.nextFollowUpAt),
    notes: d.notes,
    contacts: d.org.contacts.map((c) => ({ id: c.id, email: c.email, name: personName(c), title: c.title, bounced: c.bounced })),
    touchCount: d._count.touches,
    attention: dealAttention(
      {
        ...d,
        lastReplyAt: d.touches.find((t) => t.kind === "reply")?.at ?? null,
        lastDraftAt: d.touches.find((t) => t.kind === "email_drafted")?.at ?? null,
        allBounced: d.org.contacts.length > 0 && d.org.contacts.every((c) => c.bounced),
      },
      now,
    ),
  };
}

export async function listDeals(season?: string): Promise<DealRow[]> {
  await adminOnly();
  const now = new Date();
  const rows = await prisma.outreachDeal.findMany({
    where: season ? { season } : {},
    include: DEAL_INCLUDE,
    orderBy: [{ org: { name: "asc" } }],
  });
  return rows.map((d) => toDealRow(d, now));
}

export async function listSeasons(): Promise<string[]> {
  await adminOnly();
  const rows = await prisma.outreachDeal.findMany({ distinct: ["season"], select: { season: true } });
  const set = new Set(rows.map((r) => r.season));
  set.add(seasonOf(new Date()));
  return [...set].sort().reverse();
}

export type TouchRow = {
  id: string;
  kind: string;
  at: string;
  subject: string | null;
  note: string | null;
  threadUrl: string | null;
  actor: string;
  contact: { id: string; name: string; email: string | null } | null;
  org: { id: string; name: string } | null;
  dealId: string | null;
  template: string | null;
  campaign: string | null;
};

const TOUCH_INCLUDE = {
  actor: { select: { email: true, name: true, displayName: true } },
  contact: { select: { id: true, email: true, firstName: true, lastName: true } },
  org: { select: { id: true, name: true } },
  template: { select: { name: true } },
  campaign: { select: { name: true } },
} satisfies Prisma.OutreachTouchInclude;

function toTouchRow(t: Prisma.OutreachTouchGetPayload<{ include: typeof TOUCH_INCLUDE }>): TouchRow {
  return {
    id: t.id,
    kind: t.kind,
    at: t.at.toISOString(),
    subject: t.subject,
    note: t.note,
    threadUrl: t.threadUrl,
    actor: displayNameOf(t.actor),
    contact: t.contact ? { id: t.contact.id, name: personName(t.contact), email: t.contact.email } : null,
    org: t.org,
    dealId: t.dealId,
    template: t.template?.name ?? null,
    campaign: t.campaign?.name ?? null,
  };
}

export async function getDealDetail(id: string) {
  await adminOnly();
  const d = await prisma.outreachDeal.findUnique({ where: { id }, include: DEAL_INCLUDE });
  if (!d) return null;
  const touches = await prisma.outreachTouch.findMany({
    where: { OR: [{ dealId: id }, { orgId: d.orgId }, { contact: { orgId: d.orgId } }] },
    include: TOUCH_INCLUDE,
    orderBy: { at: "desc" },
    take: 200,
  });
  const other = await prisma.outreachDeal.findMany({
    where: { orgId: d.orgId, NOT: { id } },
    select: { id: true, season: true, stage: true, theirDeliverables: true },
    orderBy: { season: "desc" },
  });
  return { deal: toDealRow(d, new Date()), touches: touches.map(toTouchRow), otherSeasons: other };
}

export async function listOrgs() {
  await adminOnly();
  return prisma.outreachOrg.findMany({
    select: { id: true, name: true, kind: true, channel: true },
    orderBy: { name: "asc" },
  });
}

// ---- contacts --------------------------------------------------------------

export type ContactRow = {
  id: string;
  email: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  affiliation: string | null;
  tags: string[];
  org: { id: string; name: string } | null;
  doNotContact: boolean;
  bounced: boolean;
  givenCents: number;
  gifts: number;
  lastTouchAt: string | null;
};

const CONTACT_INCLUDE = {
  org: { select: { id: true, name: true } },
  donations: { select: { amountCents: true } },
  touches: { select: { at: true }, orderBy: { at: "desc" }, take: 1 },
} satisfies Prisma.OutreachContactInclude;

function toContactRow(c: Prisma.OutreachContactGetPayload<{ include: typeof CONTACT_INCLUDE }>): ContactRow {
  return {
    id: c.id,
    email: c.email,
    name: personName(c),
    firstName: c.firstName,
    lastName: c.lastName,
    affiliation: c.affiliation,
    tags: c.tags,
    org: c.org,
    doNotContact: c.doNotContact,
    bounced: c.bounced,
    givenCents: c.donations.reduce((s, d) => s + d.amountCents, 0),
    gifts: c.donations.length,
    lastTouchAt: iso(c.touches[0]?.at),
  };
}


export async function listContacts(filter: SegmentFilter, page = 0) {
  await adminOnly();
  const where = segmentWhere({ includeExcluded: true, ...filter });
  const [total, rows] = await Promise.all([
    prisma.outreachContact.count({ where }),
    prisma.outreachContact.findMany({
      where,
      include: CONTACT_INCLUDE,
      orderBy: [{ updatedAt: "desc" }],
      take: CONTACT_PAGE,
      skip: page * CONTACT_PAGE,
    }),
  ]);
  return { total, rows: rows.map(toContactRow) };
}

export async function getContactDetail(id: string) {
  await adminOnly();
  const c = await prisma.outreachContact.findUnique({
    where: { id },
    include: {
      org: { select: { id: true, name: true } },
      donations: { include: { campaign: { select: { id: true, name: true } } }, orderBy: { donatedAt: "desc" } },
    },
  });
  if (!c) return null;
  const touches = await prisma.outreachTouch.findMany({
    where: { contactId: id },
    include: TOUCH_INCLUDE,
    orderBy: { at: "desc" },
    take: 100,
  });
  return {
    contact: {
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      donations: c.donations.map((d) => ({
        id: d.id,
        amountCents: d.amountCents,
        donatedAt: d.donatedAt.toISOString(),
        perkName: d.perkName,
        perkStatus: d.perkStatus,
        displayPref: d.displayPref,
        campaign: d.campaign,
      })),
    },
    touches: touches.map(toTouchRow),
  };
}
export type ContactDetail = NonNullable<Awaited<ReturnType<typeof getContactDetail>>>;

/** Every tag in use, most used first. */
export async function allTags(): Promise<{ tag: string; count: number }[]> {
  await adminOnly();
  const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
    SELECT t AS tag, COUNT(*) AS count FROM "OutreachContact", unnest(tags) AS t GROUP BY t ORDER BY count DESC, t ASC`;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

// ---- segments --------------------------------------------------------------

export type Recipient = {
  contactId: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  org: string | null;
  orgId: string | null;
};

/** Everyone a filter selects who has an address (the copyable part of a list). */
export async function resolveSegment(filter: SegmentFilter): Promise<{ recipients: Recipient[]; withoutEmail: number }> {
  await adminOnly();
  const where = segmentWhere(filter);
  const [rows, withoutEmail] = await Promise.all([
    prisma.outreachContact.findMany({
      where: { AND: [where, { email: { not: null } }] },
      select: { id: true, email: true, firstName: true, lastName: true, org: { select: { id: true, name: true } } },
      orderBy: [{ lastName: "asc" }, { email: "asc" }],
    }),
    prisma.outreachContact.count({ where: { AND: [where, { email: null }] } }),
  ]);
  return {
    recipients: rows.map((c) => ({
      contactId: c.id,
      email: c.email!,
      name: personName(c),
      firstName: c.firstName,
      lastName: c.lastName,
      org: c.org?.name ?? null,
      orgId: c.org?.id ?? null,
    })),
    withoutEmail,
  };
}

export async function listSegments() {
  await adminOnly();
  const lists = await prisma.outreachList.findMany({ orderBy: { name: "asc" } });
  return Promise.all(
    lists.map(async (l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      filter: l.filter as SegmentFilter,
      count: await prisma.outreachContact.count({
        where: { AND: [segmentWhere(l.filter as SegmentFilter), { email: { not: null } }] },
      }),
    })),
  );
}

// ---- campaigns -------------------------------------------------------------

export async function listCampaigns() {
  await adminOnly();
  const rows = await prisma.outreachCampaign.findMany({
    include: { donations: { select: { amountCents: true, contactId: true } } },
    orderBy: [{ endsAt: "desc" }, { name: "asc" }],
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    url: c.url,
    goalCents: c.goalCents,
    startsAt: iso(c.startsAt),
    endsAt: iso(c.endsAt),
    thankYouDueAt: iso(c.thankYouDueAt),
    notes: c.notes,
    raisedCents: c.donations.reduce((s, d) => s + d.amountCents, 0),
    gifts: c.donations.length,
    donors: new Set(c.donations.map((d) => d.contactId)).size,
  }));
}
export type CampaignRow = Awaited<ReturnType<typeof listCampaigns>>[number];

export async function getCampaignDetail(id: string) {
  await adminOnly();
  const c = await prisma.outreachCampaign.findUnique({ where: { id } });
  if (!c) return null;
  const donations = await prisma.outreachDonation.findMany({
    where: { campaignId: id },
    include: { contact: { select: { id: true, email: true, firstName: true, lastName: true, address: true } } },
    orderBy: { donatedAt: "desc" },
  });
  return {
    campaign: {
      id: c.id,
      name: c.name,
      kind: c.kind,
      url: c.url,
      goalCents: c.goalCents,
      startsAt: iso(c.startsAt),
      endsAt: iso(c.endsAt),
      thankYouDueAt: iso(c.thankYouDueAt),
      notes: c.notes,
    },
    donations: donations.map((d) => ({
      id: d.id,
      amountCents: d.amountCents,
      donatedAt: d.donatedAt.toISOString(),
      perkName: d.perkName,
      perkStatus: d.perkStatus,
      displayPref: d.displayPref,
      contact: { id: d.contact.id, email: d.contact.email, name: personName(d.contact), hasAddress: !!d.contact.address },
    })),
  };
}
export type CampaignDetail = NonNullable<Awaited<ReturnType<typeof getCampaignDetail>>>;

// ---- templates -------------------------------------------------------------

export async function listTemplates() {
  await adminOnly();
  const rows = await prisma.outreachTemplate.findMany({
    include: { _count: { select: { touches: true } } },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    subject: t.subject,
    body: t.body,
    uses: t._count.touches,
    updatedAt: t.updatedAt.toISOString(),
  }));
}
export type TemplateRow = Awaited<ReturnType<typeof listTemplates>>[number];

// ---- dashboard -------------------------------------------------------------

export async function dashboard() {
  await adminOnly();
  const now = new Date();
  const season = seasonOf(now);
  const [deals, campaigns, recent, contacts, donors] = await Promise.all([
    listDeals(),
    listCampaigns(),
    prisma.outreachTouch.findMany({ include: TOUCH_INCLUDE, orderBy: { at: "desc" }, take: 15 }),
    prisma.outreachContact.count(),
    prisma.outreachContact.count({ where: { donations: { some: {} } } }),
  ]);
  const current = deals.filter((d) => d.season === season);
  const byStage: Record<string, number> = {};
  for (const d of current) byStage[d.stage] = (byStage[d.stage] ?? 0) + 1;
  const won = current.filter((d) => WON_STAGES.includes(d.stage as DealStage));
  // In play: written to, or being written to. Untouched prospects are the backlog.
  const open = current.filter((d) => ["drafting", "contacted", "in_talks"].includes(d.stage));
  const queue = deals
    .filter((d) => d.attention)
    .sort((a, b) => b.attention!.weight - a.attention!.weight || a.orgName.localeCompare(b.orgName));
  const milestones = campaigns.flatMap((c) =>
    campaignMilestones(
      { name: c.name, endsAt: c.endsAt ? new Date(c.endsAt) : null, thankYouDueAt: c.thankYouDueAt ? new Date(c.thankYouDueAt) : null },
      now,
    ).map((m) => ({ ...m, at: m.at.toISOString(), campaignId: c.id })),
  );
  return {
    season,
    byStage,
    wonCents: won.reduce((s, d) => s + (d.valueCents ?? 0), 0),
    wonCount: won.length,
    openCount: open.length,
    queue,
    milestones,
    activeCampaigns: campaigns.filter((c) => !c.endsAt || new Date(c.endsAt) >= new Date(now.getTime() - 14 * 86_400_000)),
    recent: recent.map(toTouchRow),
    contacts,
    donors,
  };
}

// ---- compose ---------------------------------------------------------------

export type ComposeSource =
  | { kind: "list"; listId: string }
  | { kind: "deals"; stages: string[]; season: string }
  | { kind: "deal"; dealId: string }
  | { kind: "contact"; contactId: string };

export type ComposeRow = {
  key: string;
  to: string[];
  contactId: string | null;
  dealId: string | null;
  orgId: string | null;
  label: string;
  vars: Record<string, string | boolean | null>;
};

/**
 * The people a merge goes to, each with the fields a template can use. A list
 * gives one row per person; sponsors give one row per deal, addressed to every
 * contact at the org.
 */
export async function composeRows(source: ComposeSource, sender: { name: string; email: string }): Promise<ComposeRow[]> {
  await adminOnly();
  const season = seasonOf(new Date());
  const senderVars = {
    sender_name: sender.name,
    sender_first_name: sender.name.split(/\s+/)[0] ?? sender.name,
    sender_email: sender.email,
    season,
  };
  const dealVars = (d: { ask: string | null; theirDeliverables: string | null; renewal: boolean; season: string } | null) => ({
    ask: d?.ask ?? null,
    their_deliverables: d?.theirDeliverables ?? null,
    renewal: d?.renewal ?? false,
    ...(d ? { season: d.season } : {}),
  });

  if (source.kind === "deals" || source.kind === "deal") {
    const deals = await prisma.outreachDeal.findMany({
      where: source.kind === "deal" ? { id: source.dealId } : { stage: { in: source.stages }, season: source.season },
      include: {
        org: { include: { contacts: { where: { doNotContact: false, bounced: false, email: { not: null } }, orderBy: { createdAt: "asc" } } } },
      },
      orderBy: { org: { name: "asc" } },
    });
    return deals.map((d) => {
      const first = d.org.contacts[0];
      return {
        key: d.id,
        to: d.org.contacts.map((c) => c.email!),
        contactId: first?.id ?? null,
        dealId: d.id,
        orgId: d.orgId,
        label: d.org.name,
        vars: {
          ...senderVars,
          ...dealVars(d),
          org: d.org.name,
          first_name: first?.firstName ?? null,
          last_name: first?.lastName ?? null,
          full_name: first ? personName(first) || null : null,
          email: first?.email ?? null,
        },
      };
    });
  }

  let filter: SegmentFilter;
  if (source.kind === "contact") filter = { includeExcluded: true };
  else {
    const list = await prisma.outreachList.findUnique({ where: { id: source.listId } });
    if (!list) return [];
    filter = list.filter as SegmentFilter;
  }
  const where = source.kind === "contact" ? { id: source.contactId } : segmentWhere(filter);
  const contacts = await prisma.outreachContact.findMany({
    where: { AND: [where, { email: { not: null } }] },
    include: {
      org: { include: { deals: { where: { season }, take: 1 } } },
      donations: { orderBy: { donatedAt: "desc" }, take: 1 },
    },
    orderBy: [{ lastName: "asc" }, { email: "asc" }],
  });
  return contacts.map((c) => {
    const deal = c.org?.deals[0] ?? null;
    return {
      key: c.id,
      to: [c.email!],
      contactId: c.id,
      dealId: deal?.id ?? null,
      orgId: c.orgId,
      label: personName(c) || c.email!,
      vars: {
        ...senderVars,
        ...dealVars(deal),
        first_name: c.firstName,
        last_name: c.lastName,
        full_name: personName(c) || null,
        email: c.email,
        org: c.org?.name ?? null,
        last_gift: c.donations[0] ? `$${(c.donations[0].amountCents / 100).toFixed(2)}` : null,
      },
    };
  });
}

/** Rows already emailed with this template in the last `days` (so a merge can resume). */
export async function recentlySent(templateId: string | null, keys: { contactId: string | null; dealId: string | null }[], days = 21) {
  await adminOnly();
  if (!templateId) return [];
  const since = new Date(Date.now() - days * 86_400_000);
  const touches = await prisma.outreachTouch.findMany({
    where: {
      templateId,
      kind: "email_sent",
      at: { gte: since },
      OR: [
        { contactId: { in: keys.map((k) => k.contactId).filter((x): x is string => !!x) } },
        { dealId: { in: keys.map((k) => k.dealId).filter((x): x is string => !!x) } },
      ],
    },
    select: { contactId: true, dealId: true, at: true },
  });
  return touches.map((t) => ({ contactId: t.contactId, dealId: t.dealId, at: t.at.toISOString() }));
}

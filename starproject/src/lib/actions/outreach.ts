"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/lib/admins";
import { createTask } from "@/lib/actions/tasks";
import { prisma } from "@/lib/db";
import {
  AFFILIATIONS,
  CAMPAIGN_KINDS,
  CHANNELS,
  DEAL_STAGES,
  DEAL_TYPES,
  OUTBOUND_TOUCHES,
  ORG_KINDS,
  PERK_STATUSES,
  TEMPLATE_KINDS,
  TOUCH_KINDS,
  seasonOf,
  type DealStage,
  type TouchKind,
} from "@/lib/outreach/constants";
import { parseDelimited } from "@/lib/outreach/csv";
import { normalizeEmail, isValidEmail } from "@/lib/outreach/emails";
import { addDays } from "@/lib/outreach/followups";
import { IMPORT_PRESETS, parseTags, planImport, planSummary, type ImportOptions, type ImportPlan } from "@/lib/outreach/importer";
import { resolveSegment } from "@/lib/outreach/queries";
import { segmentFilterSchema, type SegmentFilter } from "@/lib/outreach/segments";
import { STARTER_TEMPLATES } from "@/lib/outreach/starter-templates";
import { sameOrg } from "@/lib/outreach/orgs";

// The outreach CRM's writes. Admins only (requireAdmin on every action): the
// tables hold donors' contact details and gifts. Nothing here goes to the
// team-wide Activity feed, which every member reads; the outreach audit trail
// is OutreachTouch (who, what, when), and each action that changes a deal's
// stage or follow-up records a "note" touch saying so.

function revalidate() {
  revalidatePath("/outreach", "layout");
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof z.ZodError) {
    const f = e.flatten();
    const msg = [...Object.entries(f.fieldErrors).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`), ...f.formErrors];
    return { ok: false, error: msg.join("; ") || "Invalid input" };
  }
  if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
    return { ok: false, error: "That already exists (the name or email is taken)." };
  }
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

const optText = (max = 2000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null ? v : v.trim() || null));
// undefined: leave the field alone; null or "": clear it; else a date.
const optDate = z
  .union([z.string(), z.date()])
  .nullish()
  .transform((v) => (v === undefined ? undefined : v === null || v === "" ? null : new Date(v)))
  .refine((d) => d == null || !Number.isNaN(d.getTime()), "not a date");

// ---- orgs ------------------------------------------------------------------

const orgInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(ORG_KINDS).optional(),
  website: optText(500),
  industry: optText(200),
  channel: z.enum(CHANNELS).optional(),
  formUrl: optText(1000),
  notes: optText(5000),
});

export async function saveOrg(input: z.input<typeof orgInput>): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
    const { id, ...data } = orgInput.parse(input);
    const org = id
      ? await prisma.outreachOrg.update({ where: { id }, data })
      : await prisma.outreachOrg.upsert({ where: { name: data.name }, create: data, update: {} });
    revalidate();
    return { ok: true, id: org.id };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The org this name refers to, created if new. Matches loosely (sameOrg): the
 * sponsor sheet and the task board name the same company differently, and two
 * rows for one sponsor would split its history.
 */
/** Delete an org with its deals and touches. Its people stay, with no org. */
export async function deleteOrg(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachOrg.delete({ where: { id } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

async function orgIdFor(name: string, tx: Prisma.TransactionClient = prisma): Promise<string> {
  const n = name.trim();
  const exact = await tx.outreachOrg.findFirst({ where: { name: { equals: n, mode: "insensitive" } }, select: { id: true } });
  if (exact) return exact.id;
  const all = await tx.outreachOrg.findMany({ select: { id: true, name: true } });
  const found = all.find((o) => sameOrg(o.name, n));
  if (found) return found.id;
  return (await tx.outreachOrg.create({ data: { name: n }, select: { id: true } })).id;
}

// ---- deals -----------------------------------------------------------------

const dealInput = z.object({
  id: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().trim().max(200).optional(),
  season: z.string().trim().min(4).max(20).optional(),
  type: z.enum(DEAL_TYPES).optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  ask: optText(),
  theirDeliverables: optText(),
  valueCents: z.number().int().min(0).max(100_000_000).nullish(),
  renewal: z.boolean().optional(),
  lastContactAt: optDate,
  nextFollowUpAt: optDate,
  notes: optText(10000),
});
export type DealInput = z.input<typeof dealInput>;

/** Create a deal (by org id or name, created if new) or update fields of one. */
export async function saveDeal(input: DealInput): Promise<Result<{ id: string }>> {
  try {
    const user = await requireAdmin();
    const { id, orgId, orgName, ...fields } = dealInput.parse(input);
    if (id) {
      const before = await prisma.outreachDeal.findUniqueOrThrow({ where: { id } });
      const deal = await prisma.outreachDeal.update({ where: { id }, data: fields });
      if (fields.stage && fields.stage !== before.stage) {
        await prisma.outreachTouch.create({
          data: { kind: "note", dealId: id, orgId: deal.orgId, actorId: user.id, note: `Stage: ${before.stage} → ${fields.stage}` },
        });
      }
      revalidate();
      return { ok: true, id };
    }
    const oid = orgId ?? (orgName ? await orgIdFor(orgName) : null);
    if (!oid) return { ok: false, error: "Which organization is this deal with?" };
    const season = fields.season ?? seasonOf(new Date());
    const deal = await prisma.outreachDeal.create({
      data: { ...fields, season, orgId: oid },
    });
    revalidate();
    return { ok: true, id: deal.id };
  } catch (e) {
    return fail(e);
  }
}

export async function setDealStage(id: string, stage: DealStage): Promise<Result> {
  const r = await saveDeal({ id, stage });
  return r.ok ? { ok: true } : r;
}

/** Follow up in `days` (null clears the reminder). */
export async function scheduleFollowUp(dealId: string, days: number | null): Promise<Result> {
  try {
    await requireAdmin();
    const d = days == null ? null : addDays(new Date(), z.number().int().min(0).max(365).parse(days));
    await prisma.outreachDeal.update({ where: { id: dealId }, data: { nextFollowUpAt: d } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDeal(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachDeal.delete({ where: { id } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** The task-board project the "Add task" button files into. */
const OUTREACH_TASK_PROJECT = "Outreach Correspondence";

/**
 * "Add task": put a correspondence task for this sponsor on the task board
 * (the Outreach Correspondence project, assigned to you, due on the deal's
 * follow-up date). The task is an ordinary task made by createTask, with the
 * same activity entry and assignment email; nothing links it back, so the
 * board and the CRM stay separate. An open task for the same sponsor is
 * returned instead of making a second one.
 */
export async function createDealTask(
  dealId: string,
  input: { title?: string | null; dueDate?: string | null } = {},
): Promise<Result<{ taskId: string; number: number; existed: boolean }>> {
  try {
    const user = await requireAdmin();
    const deal = await prisma.outreachDeal.findUnique({ where: { id: dealId }, include: { org: true } });
    if (!deal) return { ok: false, error: "No such deal." };
    const project = await prisma.project.findFirst({
      where: { name: { equals: OUTREACH_TASK_PROJECT, mode: "insensitive" }, archived: false },
      select: { id: true },
    });
    if (!project) return { ok: false, error: `There is no "${OUTREACH_TASK_PROJECT}" project on the task board.` };
    const prefix = `Correspondence - ${deal.org.name}`;
    const open = await prisma.task.findFirst({
      where: { projectId: project.id, archived: false, status: { not: "done" }, title: { startsWith: prefix, mode: "insensitive" } },
      select: { id: true, number: true },
    });
    if (open) return { ok: true, taskId: open.id, number: open.number, existed: true };
    const title = (input.title?.trim() || `${prefix}${deal.ask ? ` (${deal.ask})` : ""}`).slice(0, 300);
    const due = input.dueDate ?? (deal.nextFollowUpAt ? deal.nextFollowUpAt.toISOString().slice(0, 10) : "");
    const subteam = await prisma.subteam.findFirst({ where: { name: { equals: "Outreach", mode: "insensitive" } }, select: { id: true } });
    const fd = new FormData();
    fd.set("projectId", project.id);
    fd.set("title", title);
    fd.set("description", [deal.ask, deal.theirDeliverables && `They give: ${deal.theirDeliverables}`].filter(Boolean).join("\n"));
    fd.set("assigneeIds", user.id);
    fd.set("subteamId", subteam?.id ?? "");
    fd.set("dueDate", due);
    const { id } = await createTask(fd);
    const task = await prisma.task.findUniqueOrThrow({ where: { id }, select: { number: true } });
    await prisma.outreachTouch.create({
      data: { kind: "note", dealId, orgId: deal.orgId, actorId: user.id, note: `Task #${task.number} added to ${OUTREACH_TASK_PROJECT}` },
    });
    revalidate();
    return { ok: true, taskId: id, number: task.number, existed: false };
  } catch (e) {
    return fail(e);
  }
}

// ---- touches ---------------------------------------------------------------

const touchInput = z.object({
  kind: z.enum(TOUCH_KINDS),
  contactId: z.string().nullish(),
  orgId: z.string().nullish(),
  dealId: z.string().nullish(),
  campaignId: z.string().nullish(),
  templateId: z.string().nullish(),
  subject: optText(500),
  note: optText(5000),
  threadUrl: optText(1000),
  at: optDate,
  /** For an outbound touch on a deal: remind me in this many days (null: no reminder). */
  followUpDays: z.number().int().min(0).max(365).nullish(),
});
export type TouchInput = z.input<typeof touchInput>;

async function applyTouch(tx: Prisma.TransactionClient, actorId: string, t: z.output<typeof touchInput>) {
  const at = t.at ?? new Date();
  let orgId = t.orgId ?? null;
  let dealId = t.dealId ?? null;
  if (!orgId && t.contactId) {
    orgId = (await tx.outreachContact.findUnique({ where: { id: t.contactId }, select: { orgId: true } }))?.orgId ?? null;
  }
  if (dealId && !orgId) orgId = (await tx.outreachDeal.findUnique({ where: { id: dealId }, select: { orgId: true } }))?.orgId ?? null;
  if (!dealId && orgId) {
    // A touch on a sponsor's person counts for the org's deal this season.
    dealId = (await tx.outreachDeal.findUnique({ where: { orgId_season: { orgId, season: seasonOf(at) } }, select: { id: true } }))?.id ?? null;
  }
  await tx.outreachTouch.create({
    data: {
      kind: t.kind,
      at,
      contactId: t.contactId ?? null,
      orgId,
      dealId,
      campaignId: t.campaignId ?? null,
      templateId: t.templateId ?? null,
      subject: t.subject ?? null,
      note: t.note ?? null,
      threadUrl: t.threadUrl ?? null,
      actorId,
    },
  });
  if (!dealId) return;
  const deal = await tx.outreachDeal.findUniqueOrThrow({ where: { id: dealId } });
  const data: Prisma.OutreachDealUpdateInput = {};
  const kind = t.kind as TouchKind;
  if (OUTBOUND_TOUCHES.includes(kind)) {
    if (!deal.lastContactAt || deal.lastContactAt < at) data.lastContactAt = at;
    if (deal.stage === "prospect" || deal.stage === "drafting" || deal.stage === "ghosted") data.stage = "contacted";
    if (t.followUpDays !== undefined) data.nextFollowUpAt = t.followUpDays == null ? null : addDays(at, t.followUpDays);
    else data.nextFollowUpAt = null; // a fresh touch restarts the quiet clock
  } else if (kind === "reply") {
    if (["prospect", "drafting", "contacted", "ghosted"].includes(deal.stage)) data.stage = "in_talks";
    data.nextFollowUpAt = t.followUpDays == null ? null : addDays(at, t.followUpDays);
  } else if (kind === "email_drafted" && deal.stage === "prospect") {
    data.stage = "drafting";
  }
  if (Object.keys(data).length) await tx.outreachDeal.update({ where: { id: dealId }, data });
}

/**
 * Record an interaction. On a deal, an outbound touch (email sent, form
 * submitted, call, meeting) sets last contact, moves a prospect to Contacted
 * and resets the follow-up; a reply moves anything not yet committed to In talks.
 */
export async function logTouch(input: TouchInput): Promise<Result> {
  try {
    const user = await requireAdmin();
    const t = touchInput.parse(input);
    if (!t.contactId && !t.orgId && !t.dealId) return { ok: false, error: "A touch needs a person, an org or a deal." };
    await prisma.$transaction((tx) => applyTouch(tx, user.id, t));
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Compose → "Mark sent" for several recipients at once. */
export async function logTouches(inputs: TouchInput[]): Promise<Result<{ logged: number }>> {
  try {
    const user = await requireAdmin();
    const ts = z.array(touchInput).max(2000).parse(inputs);
    await prisma.$transaction(async (tx) => {
      for (const t of ts) await applyTouch(tx, user.id, t);
    });
    revalidate();
    return { ok: true, logged: ts.length };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTouch(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachTouch.delete({ where: { id } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- contacts --------------------------------------------------------------

const contactInput = z.object({
  id: z.string().optional(),
  email: z
    .string()
    .nullish()
    .transform((v) => (v == null ? v : normalizeEmail(v) || null))
    .refine((v) => v == null || isValidEmail(v), "not an email address"),
  altEmails: z.array(z.string()).optional(),
  firstName: optText(100),
  lastName: optText(100),
  title: optText(200),
  phone: optText(50),
  address: optText(500),
  city: optText(100),
  state: optText(100),
  zip: optText(20),
  country: optText(100),
  affiliation: z.enum(AFFILIATIONS).nullish(),
  tags: z.array(z.string()).optional(),
  orgId: z.string().nullish(),
  orgName: z.string().trim().max(200).nullish(),
  doNotContact: z.boolean().optional(),
  bounced: z.boolean().optional(),
  notes: optText(10000),
});
export type ContactInput = z.input<typeof contactInput>;

export async function saveContact(input: ContactInput): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
    const { id, orgName, tags, altEmails, ...rest } = contactInput.parse(input);
    const data: Prisma.OutreachContactUncheckedCreateInput = {
      ...rest,
      ...(tags ? { tags: parseTags(tags.join(",")) } : {}),
      ...(altEmails ? { altEmails: altEmails.map(normalizeEmail).filter(isValidEmail) } : {}),
    };
    if (orgName !== undefined) data.orgId = orgName ? await orgIdFor(orgName) : null;
    const c = id
      ? await prisma.outreachContact.update({ where: { id }, data })
      : await prisma.outreachContact.create({ data: { ...data, source: "added by hand" } });
    revalidate();
    return { ok: true, id: c.id };
  } catch (e) {
    return fail(e);
  }
}

/** Bulk tag / untag from the People table. */
export async function retagContacts(ids: string[], add: string[], remove: string[]): Promise<Result<{ changed: number }>> {
  try {
    await requireAdmin();
    const plus = parseTags(add.join(","));
    const minus = new Set(parseTags(remove.join(",")));
    const rows = await prisma.outreachContact.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
    await prisma.$transaction(
      rows.map((r) =>
        prisma.outreachContact.update({
          where: { id: r.id },
          data: { tags: [...new Set([...r.tags, ...plus])].filter((t) => !minus.has(t)) },
        }),
      ),
    );
    revalidate();
    return { ok: true, changed: rows.length };
  } catch (e) {
    return fail(e);
  }
}

export async function setDoNotContact(ids: string[], value: boolean): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachContact.updateMany({ where: { id: { in: ids } }, data: { doNotContact: value } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteContacts(ids: string[]): Promise<Result<{ deleted: number }>> {
  try {
    await requireAdmin();
    const r = await prisma.outreachContact.deleteMany({ where: { id: { in: ids } } });
    revalidate();
    return { ok: true, deleted: r.count };
  } catch (e) {
    return fail(e);
  }
}

// ---- lists -----------------------------------------------------------------

/** Live count + addresses for a filter (the list builder calls this as you edit). */
export async function previewSegment(filter: SegmentFilter) {
  await requireAdmin();
  return resolveSegment(segmentFilterSchema.parse(filter));
}

const listInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  description: optText(1000),
  filter: segmentFilterSchema,
});

export async function saveSegment(input: z.input<typeof listInput>): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
    const { id, ...data } = listInput.parse(input);
    const l = id
      ? await prisma.outreachList.update({ where: { id }, data })
      : await prisma.outreachList.create({ data });
    revalidate();
    return { ok: true, id: l.id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSegment(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachList.delete({ where: { id } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- templates -------------------------------------------------------------

const templateInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(TEMPLATE_KINDS).optional(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(50_000),
});

export async function saveTemplate(input: z.input<typeof templateInput>): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
    const { id, ...data } = templateInput.parse(input);
    const t = id
      ? await prisma.outreachTemplate.update({ where: { id }, data })
      : await prisma.outreachTemplate.create({ data });
    revalidate();
    return { ok: true, id: t.id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTemplate(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.outreachTemplate.delete({ where: { id } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- campaigns -------------------------------------------------------------

const campaignInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(CAMPAIGN_KINDS).optional(),
  url: optText(1000),
  goalCents: z.number().int().min(0).max(100_000_000).nullish(),
  startsAt: optDate,
  endsAt: optDate,
  thankYouDueAt: optDate,
  notes: optText(10000),
});

export async function saveCampaign(input: z.input<typeof campaignInput>): Promise<Result<{ id: string }>> {
  try {
    await requireAdmin();
    const { id, ...data } = campaignInput.parse(input);
    const c = id
      ? await prisma.outreachCampaign.update({ where: { id }, data })
      : await prisma.outreachCampaign.create({ data });
    revalidate();
    return { ok: true, id: c.id };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a campaign with its gifts. Referrals and touches stay, unlinked. */
export async function deleteCampaign(id: string): Promise<Result> {
  try {
    await requireAdmin();
    await prisma.$transaction([
      prisma.outreachDonation.deleteMany({ where: { campaignId: id } }),
      prisma.outreachCampaign.delete({ where: { id } }),
    ]);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setPerkStatus(donationIds: string[], status: (typeof PERK_STATUSES)[number]): Promise<Result> {
  try {
    await requireAdmin();
    z.enum(PERK_STATUSES).parse(status);
    await prisma.outreachDonation.updateMany({ where: { id: { in: donationIds } }, data: { perkStatus: status } });
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- import ----------------------------------------------------------------

const importInput = z.object({
  text: z.string().min(1).max(5_000_000),
  preset: z.enum(IMPORT_PRESETS).default("auto"),
  tags: z.array(z.string()).default([]),
  affiliation: z.enum(AFFILIATIONS).nullish().transform((v) => v ?? null),
  campaignId: z.string().nullish().transform((v) => v || null),
  season: z.string().default(() => seasonOf(new Date())),
  applyFixes: z.boolean().default(false),
  source: z.string().trim().max(200).default("import"),
});
export type ImportInput = z.input<typeof importInput>;

function plan(input: ImportInput): { plan: ImportPlan; options: ImportOptions } {
  const o = importInput.parse(input);
  const options: ImportOptions = {
    preset: o.preset,
    tags: parseTags(o.tags.join(",")),
    affiliation: o.affiliation,
    campaignId: o.campaignId,
    season: o.season,
    applyFixes: o.applyFixes,
    source: o.source,
  };
  return { plan: planImport(parseDelimited(o.text, undefined, true), options), options };
}

/** What an import would do, without writing anything. */
export async function previewImport(input: ImportInput) {
  try {
    await requireAdmin();
    const { plan: p } = plan(input);
    const emails = p.contacts.map((c) => c.email).filter((e): e is string => !!e);
    const existing = new Set(
      (await prisma.outreachContact.findMany({ where: { email: { in: emails } }, select: { email: true } })).map((c) => c.email),
    );
    const knownRefs = new Set(
      (
        await prisma.outreachDonation.findMany({
          where: { externalRef: { in: p.donations.map((d) => d.externalRef) } },
          select: { externalRef: true },
        })
      ).map((d) => d.externalRef),
    );
    return {
      ok: true as const,
      preset: p.preset,
      headerRow: p.headerRow,
      summary: {
        ...planSummary(p),
        newContacts: p.contacts.filter((c) => !c.email || !existing.has(c.email)).length,
        updatedContacts: p.contacts.filter((c) => c.email && existing.has(c.email)).length,
        newDonations: p.donations.filter((d) => !knownRefs.has(d.externalRef)).length,
      },
      sampleContacts: p.contacts.slice(0, 25).map((c) => ({
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        org: c.orgName,
        tags: c.tags,
        exists: !!c.email && existing.has(c.email),
      })),
      sampleDeals: p.deals.slice(0, 50),
      rejected: p.rejected.slice(0, 100),
      flagged: p.flagged.slice(0, 100),
    };
  } catch (e) {
    return fail(e);
  }
}
export type ImportPreview = Extract<Awaited<ReturnType<typeof previewImport>>, { ok: true }>;

/**
 * Write an import. Re-parses the text on the server (the preview is advisory).
 * Contacts merge by email: existing values win, empty ones are filled, tags are
 * added. Donations upsert on their platform ref, so importing the
 * same export twice changes nothing. Sponsor rows become one deal per org for
 * the chosen season (left alone if that deal exists).
 */
export async function commitImport(input: ImportInput): Promise<
  Result<{ contactsCreated: number; contactsUpdated: number; donations: number; deals: number; rejected: number }>
> {
  try {
    await requireAdmin();
    const { plan: p, options } = plan(input);
    let contactsCreated = 0;
    let contactsUpdated = 0;
    let donations = 0;
    let deals = 0;

    await prisma.$transaction(
      async (tx) => {
        const orgIds = new Map<string, string>();
        const orgFor = async (name: string, kind?: string) => {
          const k = name.toLowerCase();
          if (!orgIds.has(k)) {
            const id = await orgIdFor(name, tx);
            if (kind) await tx.outreachOrg.updateMany({ where: { id, kind: "company" }, data: { kind } });
            orgIds.set(k, id);
          }
          return orgIds.get(k)!;
        };

        for (const d of p.deals) {
          const orgId = await orgFor(d.orgName, d.orgKind);
          const exists = await tx.outreachDeal.findUnique({ where: { orgId_season: { orgId, season: options.season } } });
          if (exists) continue;
          await tx.outreachDeal.create({
            data: {
              orgId,
              season: options.season,
              type: d.type,
              stage: d.stage,
              renewal: d.renewal,
              theirDeliverables: d.theirDeliverables,
              valueCents: d.valueCents,
              notes: d.notes,
            },
          });
          deals++;
        }

        const idByEmail = new Map<string, string>();
        for (const c of p.contacts) {
          const orgId = c.orgName ? await orgFor(c.orgName) : null;
          const prev = c.email ? await tx.outreachContact.findUnique({ where: { email: c.email } }) : null;
          const fill = <T>(old: T | null, val: T | null) => (old ?? val) as T | null;
          let id: string;
          if (prev) {
            await tx.outreachContact.update({
              where: { id: prev.id },
              data: {
                firstName: fill(prev.firstName, c.firstName),
                lastName: fill(prev.lastName, c.lastName),
                title: fill(prev.title, c.title),
                phone: fill(prev.phone, c.phone),
                address: fill(prev.address, c.address),
                city: fill(prev.city, c.city),
                state: fill(prev.state, c.state),
                zip: fill(prev.zip, c.zip),
                country: fill(prev.country, c.country),
                affiliation: fill(prev.affiliation, c.affiliation),
                orgId: fill(prev.orgId, orgId),
                notes: fill(prev.notes, c.notes),
                tags: [...new Set([...prev.tags, ...c.tags])],
                altEmails: [...new Set([...prev.altEmails, ...c.altEmails])],
              },
            });
            id = prev.id;
            contactsUpdated++;
          } else {
            const created = await tx.outreachContact.create({
              data: {
                email: c.email,
                altEmails: c.altEmails,
                firstName: c.firstName,
                lastName: c.lastName,
                title: c.title,
                phone: c.phone,
                address: c.address,
                city: c.city,
                state: c.state,
                zip: c.zip,
                country: c.country,
                affiliation: c.affiliation,
                tags: c.tags,
                orgId,
                notes: c.notes,
                source: options.source,
              },
            });
            id = created.id;
            contactsCreated++;
          }
          if (c.email) idByEmail.set(c.email, id);
        }

        for (const d of p.donations) {
          const contactId = idByEmail.get(d.email);
          if (!contactId) continue;
          const data = {
            contactId,
            campaignId: options.campaignId,
            amountCents: d.amountCents,
            donatedAt: new Date(d.donatedAt),
            perkName: d.perkName,
            perkStatus: d.perkName ? "pending" : "none",
            displayPref: d.displayPref,
            externalRef: d.externalRef,
          };
          const existing = await tx.outreachDonation.findUnique({ where: { externalRef: d.externalRef } });
          if (existing) continue;
          await tx.outreachDonation.create({ data });
          donations++;
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    revalidate();
    return { ok: true, contactsCreated, contactsUpdated, donations, deals, rejected: p.rejected.length };
  } catch (e) {
    return fail(e);
  }
}

/** Add any of the starter templates not already here (matched by name). */
export async function installStarterTemplates(): Promise<Result<{ added: number }>> {
  try {
    await requireAdmin();
    const have = new Set((await prisma.outreachTemplate.findMany({ select: { name: true } })).map((t) => t.name));
    const missing = STARTER_TEMPLATES.filter((t) => !have.has(t.name));
    if (missing.length) await prisma.outreachTemplate.createMany({ data: missing });
    revalidate();
    return { ok: true, added: missing.length };
  } catch (e) {
    return fail(e);
  }
}

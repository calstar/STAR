import { z } from "zod";

import { requireAdmin } from "@/lib/admins";
import {
  commitImport,
  deleteCampaign,
  deleteContacts,
  deleteDeal,
  deleteOrg,
  deleteSegment,
  deleteTemplate,
  deleteTouch,
  installStarterTemplates,
  logTouches,
  saveTemplate,
  setPerkStatus,
  importTrackerTasks,
  logTouch,
  previewImport,
  retagContacts,
  saveCampaign,
  saveContact,
  saveDeal,
  saveOrg,
  saveSegment,
  scheduleFollowUp,
} from "@/lib/actions/outreach";
import { displayNameOf } from "@/lib/names";
import { gmailComposeUrl } from "@/lib/outreach/compose";
import {
  AFFILIATIONS,
  CAMPAIGN_KINDS,
  CHANNELS,
  ORG_KINDS,
  PERK_STATUSES,
  TEMPLATE_KINDS,
  DEAL_STAGES,
  DEAL_TYPES,
  TOUCH_KINDS,
} from "@/lib/outreach/constants";
import { IMPORT_PRESETS } from "@/lib/outreach/importer";
import { render } from "@/lib/outreach/merge";
import {
  composeRows,
  dashboard,
  getCampaignDetail,
  getContactDetail,
  getDealDetail,
  listCampaigns,
  listContacts,
  listDeals,
  listSegments,
  listTemplates,
  resolveSegment,
} from "@/lib/outreach/queries";
import { segmentFilterSchema } from "@/lib/outreach/segments";

import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// The /outreach CRM: sponsors (deals), people, mailing lists, campaigns,
// templates and imports. Admins only, every tool: the rows hold donors'
// contact details and gifts. Reads check here (the page's layout checks for the
// UI); writes call the same server actions as the pages, which check again.
// Nothing sends email: a merge comes back as Gmail compose links to open.

const admin = "Admins only.";

const TOUCH_SHAPE = {
        kind: z.enum(TOUCH_KINDS),
        dealId: z.string().optional(),
        orgId: z.string().optional(),
        contactId: z.string().optional(),
        campaignId: z.string().optional(),
        templateId: z.string().optional(),
        subject: z.string().max(500).optional(),
        note: z.string().max(5000).optional(),
        threadUrl: z.string().max(1000).optional(),
        at: z.string().optional().describe("ISO date-time; default now"),
        followUpDays: z.number().int().min(0).max(365).nullish(),
      };

function check<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

export const outreachTools: ToolModule = (server) => {
  defineTool(
    server,
    "get_outreach_dashboard",
    {
      description: `${admin} The /outreach Today page: deals needing attention (every address bounced, they replied and it's our move, follow-up due, gone quiet, draft never sent, form to submit, renewal not started) sorted by urgency, this season's pipeline counts and committed dollars, campaign deadlines coming up, and recent touches.`,
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await requireAdmin();
      return dashboard();
    },
  );

  defineTool(
    server,
    "list_sponsors",
    {
      description: `${admin} Sponsor deals as /outreach/sponsors lists them: org, season, type, stage, ask, what they give, value, owner, last contact, next follow-up, contacts, and why it needs attention. Filter by season ("2026–27"; omit for all) and stage.`,
      inputSchema: {
        season: z.string().optional(),
        stage: z.enum(DEAL_STAGES).optional(),
        needsAttention: z.boolean().optional().describe("Only deals the dashboard would list"),
      },
      annotations: READ,
    },
    async ({ season, stage, needsAttention }) => {
      await requireAdmin();
      return (await listDeals(season)).filter((d) => (!stage || d.stage === stage) && (!needsAttention || d.attention));
    },
  );

  defineTool(
    server,
    "get_sponsor",
    {
      description: `${admin} One deal with its full touch history (emails, replies, forms, notes) and the org's other seasons.`,
      inputSchema: { dealId: z.string().min(1) },
      annotations: READ,
    },
    async ({ dealId }) => {
      await requireAdmin();
      const d = await getDealDetail(dealId);
      if (!d) throw new Error("No such deal.");
      return d;
    },
  );

  defineTool(
    server,
    "save_sponsor",
    {
      description: `${admin} Create a deal (give orgName or orgId; the org is created if new; season defaults to the current one) or update one (give dealId and only the fields to change; null clears). Stage changes are recorded as a note touch.`,
      inputSchema: {
        dealId: z.string().optional(),
        orgId: z.string().optional(),
        orgName: z.string().max(200).optional(),
        season: z.string().optional(),
        type: z.enum(DEAL_TYPES).optional(),
        stage: z.enum(DEAL_STAGES).optional(),
        ask: z.string().max(2000).nullish(),
        theirDeliverables: z.string().max(2000).nullish(),
        ourDeliverables: z.string().max(2000).nullish(),
        valueCents: z.number().int().min(0).nullish(),
        project: z.string().max(100).nullish(),
        renewal: z.boolean().optional(),
        nextFollowUpAt: z.string().nullish().describe("YYYY-MM-DD; null clears"),
        notes: z.string().max(10000).nullish(),
      },
      annotations: WRITE,
    },
    async ({ dealId, ...rest }) => {
      const r = check(await saveDeal({ id: dealId, ...rest }));
      return (await getDealDetail(r.id))?.deal;
    },
  );

  defineTool(
    server,
    "save_outreach_org",
    {
      description: `${admin} Create an organization or update one (orgId): kind (${ORG_KINDS.join(", ")}), website, and how requests reach them (channel ${CHANNELS.join(", ")}; formUrl for a web form, which puts the deal on the dashboard's "form to submit" queue).`,
      inputSchema: {
        orgId: z.string().optional(),
        name: z.string().min(1).max(200),
        kind: z.enum(ORG_KINDS).optional(),
        website: z.string().nullish(),
        industry: z.string().nullish(),
        channel: z.enum(CHANNELS).optional(),
        formUrl: z.string().nullish(),
        notes: z.string().nullish(),
      },
      annotations: WRITE,
    },
    async ({ orgId, ...rest }) => check(await saveOrg({ id: orgId, ...rest })),
  );

  defineTool(
    server,
    "log_outreach_touch",
    {
      description: `${admin} Record an interaction (${TOUCH_KINDS.join(", ")}) with a person, org or deal. On a deal an outbound touch sets last contact, moves Prospect/Drafting to Contacted and sets the follow-up (followUpDays; omit to clear); a reply moves anything not yet committed to In talks.`,
      inputSchema: TOUCH_SHAPE,
      annotations: WRITE,
    },
    async (args) => {
      check(await logTouch(args));
      return { done: true };
    },
  );

  defineTool(
    server,
    "delete_outreach_touch",
    {
      description: `${admin} Delete one touch from a timeline (a mis-logged email, a bounce logged as a reply). Doesn't undo the stage or dates it moved.`,
      inputSchema: { touchId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ touchId }) => {
      check(await deleteTouch(touchId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "delete_outreach_contacts",
    {
      description: `${admin} Delete people with their gifts, referrals and touches. To stop emailing someone, prefer save_outreach_contact doNotContact.`,
      inputSchema: { contactIds: z.array(z.string()).min(1).max(1000) },
      annotations: DESTRUCTIVE,
    },
    async ({ contactIds }) => check(await deleteContacts(contactIds)),
  );

  defineTool(
    server,
    "schedule_sponsor_follow_up",
    {
      description: `${admin} Remind about a deal in N days (null clears the reminder).`,
      inputSchema: { dealId: z.string().min(1), days: z.number().int().min(0).max(365).nullable() },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ dealId, days }) => {
      check(await scheduleFollowUp(dealId, days));
      return { done: true };
    },
  );

  defineTool(
    server,
    "import_sponsors_from_tasks",
    {
      description: `${admin} One deal per Outreach Correspondence task with none, read from its title ("Correspondence - Garmin (inReach …)") and linked to the task. Returns how many were created and the titles it couldn't read.`,
      inputSchema: {},
      annotations: WRITE,
    },
    async () => check(await importTrackerTasks()),
  );

  defineTool(
    server,
    "list_outreach_contacts",
    {
      description: `${admin} People, as /outreach/people lists them (200 a page), filtered by a segment filter: search, tagsAny/All/None, affiliations, orgKinds, donatedTo (campaign id or "any"), notDonatedTo, referredBy, dealStages(+dealSeason), includeExcluded.`,
      inputSchema: { filter: segmentFilterSchema.default({}), page: z.number().int().min(0).default(0) },
      annotations: READ,
    },
    async ({ filter, page }) => {
      await requireAdmin();
      return listContacts(filter, page);
    },
  );

  defineTool(
    server,
    "get_outreach_contact",
    {
      description: `${admin} One person: details, mailing address, gifts, who referred them, touch history.`,
      inputSchema: { contactId: z.string().min(1) },
      annotations: READ,
    },
    async ({ contactId }) => {
      await requireAdmin();
      const c = await getContactDetail(contactId);
      if (!c) throw new Error("No such contact.");
      return c;
    },
  );

  defineTool(
    server,
    "save_outreach_contact",
    {
      description: `${admin} Create a person or update one (contactId + the fields to change). Email is normalized and must be unique; orgName links (and creates) an org; tags replace the set.`,
      inputSchema: {
        contactId: z.string().optional(),
        email: z.string().nullish(),
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
        title: z.string().nullish(),
        phone: z.string().nullish(),
        orgName: z.string().nullish(),
        affiliation: z.enum(AFFILIATIONS).nullish(),
        tags: z.array(z.string()).optional(),
        doNotContact: z.boolean().optional(),
        bounced: z.boolean().optional().describe("Their address bounces; lists and merges leave it out"),
        notes: z.string().nullish(),
      },
      annotations: WRITE,
    },
    async ({ contactId, ...rest }) => {
      const r = check(await saveContact({ id: contactId, ...rest }));
      return getContactDetail(r.id);
    },
  );

  defineTool(
    server,
    "tag_outreach_contacts",
    {
      description: `${admin} Add and/or remove tags on several people at once.`,
      inputSchema: {
        contactIds: z.array(z.string()).min(1).max(5000),
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ contactIds, add, remove }) => check(await retagContacts(contactIds, add, remove)),
  );

  defineTool(
    server,
    "list_outreach_lists",
    {
      description: `${admin} Saved mailing lists (segment filters) with how many addresses each selects now.`,
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await requireAdmin();
      return listSegments();
    },
  );

  defineTool(
    server,
    "get_outreach_list_emails",
    {
      description: `${admin} The addresses a saved list (listId) or an ad-hoc filter selects, excluding do-not-contact and bounced unless includeExcluded; plus a comma-joined string ready to paste into BCC.`,
      inputSchema: { listId: z.string().optional(), filter: segmentFilterSchema.optional() },
      annotations: READ,
    },
    async ({ listId, filter }) => {
      await requireAdmin();
      let f = filter ?? {};
      if (listId) {
        const l = (await listSegments()).find((x) => x.id === listId);
        if (!l) throw new Error("No such list.");
        f = l.filter;
      }
      const r = await resolveSegment(f);
      return { ...r, count: r.recipients.length, bcc: r.recipients.map((x) => x.email).join(", ") };
    },
  );

  defineTool(
    server,
    "save_outreach_list",
    {
      description: `${admin} Create or update (listId) a saved mailing list from a segment filter.`,
      inputSchema: {
        listId: z.string().optional(),
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        filter: segmentFilterSchema,
      },
      annotations: WRITE,
    },
    async ({ listId, ...rest }) => check(await saveSegment({ id: listId, ...rest })),
  );

  defineTool(
    server,
    "list_outreach_templates",
    {
      description: `${admin} Email templates with {{merge_fields}}, their kind and how often each was used.`,
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await requireAdmin();
      return listTemplates();
    },
  );

  defineTool(
    server,
    "get_outreach_merge",
    {
      description: `${admin} Mail-merge a template for a saved list (listId), sponsors in stages (stages + season), one deal, or one contact: each recipient's rendered subject and body, the merge fields still missing, and a Gmail compose link that opens it filled in. Nothing is sent or logged; log sends with log_outreach_touch.`,
      inputSchema: {
        templateId: z.string().min(1),
        listId: z.string().optional(),
        stages: z.array(z.enum(DEAL_STAGES)).optional(),
        season: z.string().optional(),
        dealId: z.string().optional(),
        contactId: z.string().optional(),
        campaignId: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ,
    },
    async ({ templateId, listId, stages, season, dealId, contactId, campaignId, limit }) => {
      const user = await requireAdmin();
      const tpl = (await listTemplates()).find((t) => t.id === templateId);
      if (!tpl) throw new Error("No such template.");
      const source = listId
        ? { kind: "list" as const, listId }
        : dealId
          ? { kind: "deal" as const, dealId }
          : contactId
            ? { kind: "contact" as const, contactId }
            : stages?.length
              ? { kind: "deals" as const, stages, season: season ?? (await dashboard()).season }
              : null;
      if (!source) throw new Error("Say who it goes to: listId, dealId, contactId, or stages.");
      const campaignUrl = campaignId ? ((await listCampaigns()).find((c) => c.id === campaignId)?.url ?? null) : null;
      const rows = await composeRows(source, { name: user.name ?? displayNameOf(user), email: user.email });
      return rows.slice(0, limit).map((r) => {
        const vars = { ...r.vars, campaign_url: campaignUrl };
        const subject = render(tpl.subject, vars);
        const body = render(tpl.body, vars);
        return {
          to: r.to,
          contactId: r.contactId,
          dealId: r.dealId,
          label: r.label,
          subject: subject.text,
          body: body.text,
          missing: [...new Set([...subject.missing, ...body.missing])],
          gmailUrl: gmailComposeUrl({ to: r.to, subject: subject.text, body: body.text, authuser: user.email }),
        };
      });
    },
  );

  defineTool(
    server,
    "list_outreach_campaigns",
    {
      description: `${admin} Campaigns (crowdfunding, newsletters, events) with dates, goal, raised, gifts and donors.`,
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      await requireAdmin();
      return listCampaigns();
    },
  );

  defineTool(
    server,
    "get_outreach_campaign",
    {
      description: `${admin} One campaign: every gift (with perk status and display preference), and the ambassador table (contacts each member supplied, how many gave, dollars credited).`,
      inputSchema: { campaignId: z.string().min(1) },
      annotations: READ,
    },
    async ({ campaignId }) => {
      await requireAdmin();
      const c = await getCampaignDetail(campaignId);
      if (!c) throw new Error("No such campaign.");
      return c;
    },
  );

  defineTool(
    server,
    "save_outreach_campaign",
    {
      description: `${admin} Create or update (campaignId) a campaign. Dates are ISO; goalCents in cents.`,
      inputSchema: {
        campaignId: z.string().optional(),
        name: z.string().min(1).max(200),
        kind: z.enum(CAMPAIGN_KINDS).optional(),
        url: z.string().nullish(),
        goalCents: z.number().int().min(0).nullish(),
        startsAt: z.string().nullish(),
        endsAt: z.string().nullish(),
        thankYouDueAt: z.string().nullish(),
        notes: z.string().nullish(),
      },
      annotations: WRITE,
    },
    async ({ campaignId, ...rest }) => check(await saveCampaign({ id: campaignId, ...rest })),
  );

  defineTool(
    server,
    "import_outreach_sheet",
    {
      description: `${admin} Import a sheet pasted as TSV/CSV text with a header row: ${IMPORT_PRESETS.join(", ")} (auto detects). dryRun (default true) returns the preview (new/merged/rejected/flagged counts and samples) without writing; dryRun=false writes it. People merge by email; ScaleFunder gifts are idempotent on sf_id.`,
      inputSchema: {
        text: z.string().min(1),
        preset: z.enum(IMPORT_PRESETS).default("auto"),
        tags: z.array(z.string()).default([]),
        affiliation: z.enum(AFFILIATIONS).nullish(),
        campaignId: z.string().nullish(),
        season: z.string().optional(),
        applyFixes: z.boolean().default(true),
        source: z.string().default("import (MCP)"),
        dryRun: z.boolean().default(true),
      },
      annotations: WRITE,
    },
    async ({ dryRun, ...input }) => (dryRun ? check(await previewImport(input)) : check(await commitImport(input))),
  );

  defineTool(
    server,
    "log_outreach_touches",
    {
      description: `${admin} Log several touches at once, in one transaction (what Compose's "Mark sent" does after a merge): each item is a log_outreach_touch.`,
      inputSchema: { touches: z.array(z.object(TOUCH_SHAPE)).min(1).max(2000) },
      annotations: WRITE,
    },
    async ({ touches }) => check(await logTouches(touches)),
  );

  defineTool(
    server,
    "delete_outreach_org",
    {
      description: `${admin} Delete an organization with every season's deal and its touches. Its people stay, with no org.`,
      inputSchema: { orgId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ orgId }) => {
      check(await deleteOrg(orgId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "delete_outreach_campaign",
    {
      description: `${admin} Delete a campaign and the gifts recorded under it. People, referrals and touches stay.`,
      inputSchema: { campaignId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ campaignId }) => {
      check(await deleteCampaign(campaignId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "delete_sponsor",
    {
      description: `${admin} Delete one season's deal with a sponsor, with its touches. The org and its people stay.`,
      inputSchema: { dealId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ dealId }) => {
      check(await deleteDeal(dealId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "delete_outreach_list",
    {
      description: `${admin} Delete a saved mailing list. Nobody on it is deleted.`,
      inputSchema: { listId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ listId }) => {
      check(await deleteSegment(listId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "save_outreach_template",
    {
      description: `${admin} Create or update (templateId) an email template. Body and subject take {{field}}, {{field|fallback}}, {{#field}}…{{/field}} and {{^field}}…{{/field}}; see list_outreach_templates and get_outreach_merge.`,
      inputSchema: {
        templateId: z.string().optional(),
        name: z.string().min(1).max(200),
        kind: z.enum(TEMPLATE_KINDS).optional(),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(50_000),
      },
      annotations: WRITE,
    },
    async ({ templateId, ...rest }) => check(await saveTemplate({ id: templateId, ...rest })),
  );

  defineTool(
    server,
    "delete_outreach_template",
    {
      description: `${admin} Delete an email template. Touches that used it keep their subject.`,
      inputSchema: { templateId: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ templateId }) => {
      check(await deleteTemplate(templateId));
      return { deleted: true };
    },
  );

  defineTool(
    server,
    "install_outreach_starter_templates",
    {
      description: `${admin} Add whichever of the built-in starter templates (sponsor renewal, cold ask, follow-up, thank-you; crowdfunding ask, final days, thank-you; event) are missing, matched by name.`,
      inputSchema: {},
      annotations: IDEMPOTENT_WRITE,
    },
    async () => check(await installStarterTemplates()),
  );

  defineTool(
    server,
    "set_outreach_perk_status",
    {
      description: `${admin} Mark donations' perks ${PERK_STATUSES.join(" / ")} (the campaign page's perk checklist).`,
      inputSchema: { donationIds: z.array(z.string()).min(1).max(2000), status: z.enum(PERK_STATUSES) },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ donationIds, status }) => {
      check(await setPerkStatus(donationIds, status));
      return { done: true };
    },
  );
};

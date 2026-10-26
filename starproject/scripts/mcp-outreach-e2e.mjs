#!/usr/bin/env node
// End-to-end check of the outreach CRM's MCP tools against a running app, as a
// real MCP client. Creates an "[mcp-e2e …]" org, deal, person, list, template
// and campaign, walks them through every outreach tool, deletes them again, and
// exits 1 if any check fails. Nothing real is touched except
// install_outreach_starter_templates (idempotent: it only adds missing ones).
//
//   MCP_URL=http://localhost:3100/api/mcp MCP_TOKEN=sp_<admin> \
//     [MCP_MEMBER_TOKEN=sp_<non-admin>] node scripts/mcp-outreach-e2e.mjs
//
// With MCP_MEMBER_TOKEN it also checks that a non-admin is refused every read.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/api/mcp";
const token = process.env.MCP_TOKEN;
const memberToken = process.env.MCP_MEMBER_TOKEN;
if (!token) {
  console.error("MCP_TOKEN (an admin's) is required: node scripts/mcp-token.mjs you@berkeley.edu");
  process.exit(2);
}

const STAMP = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const TAG = `[mcp-e2e ${STAMP}]`;
const TAG_SLUG = `mcp-e2e-${STAMP}`;
const EMAIL = `mcp-e2e-${STAMP}@example.com`;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  -- ${detail}` : ""}`);
  return ok;
};

async function connect(t) {
  const c = new Client({ name: "starproject-outreach-e2e", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
  return c;
}
const client = await connect(token);

async function call(name, args = {}, c = client) {
  const res = await c.callTool({ name, arguments: args });
  const text = res.content?.map((x) => x.text ?? "").join("") ?? "";
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { ok: !res.isError, data, text };
}
async function must(name, args) {
  const r = await call(name, args);
  if (!check(name, r.ok, r.ok ? "" : r.text.slice(0, 200))) throw new Error(`${name} failed`);
  return r.data;
}

const EXPECTED = [
  "get_outreach_dashboard", "list_sponsors", "get_sponsor", "save_sponsor", "delete_sponsor",
  "save_outreach_org", "delete_outreach_org", "log_outreach_touch", "log_outreach_touches", "delete_outreach_touch",
  "schedule_sponsor_follow_up", "import_sponsors_from_tasks", "list_outreach_contacts", "get_outreach_contact",
  "save_outreach_contact", "tag_outreach_contacts", "delete_outreach_contacts", "list_outreach_lists",
  "get_outreach_list_emails", "save_outreach_list", "delete_outreach_list", "list_outreach_templates",
  "save_outreach_template", "delete_outreach_template", "install_outreach_starter_templates", "get_outreach_merge",
  "list_outreach_campaigns", "get_outreach_campaign", "save_outreach_campaign", "delete_outreach_campaign",
  "set_outreach_perk_status", "import_outreach_sheet",
];

const made = {};
try {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const missing = EXPECTED.filter((n) => !names.has(n));
  check("every outreach tool is registered", missing.length === 0, missing.join(", "));
  for (const n of EXPECTED) {
    const t = tools.find((x) => x.name === n);
    if (t && !/admins only/i.test(t.description ?? "")) check(`${n} says admins only`, false);
    if (t && t.inputSchema?.type !== "object") check(`${n} has an object input schema`, false);
  }

  const dash0 = await must("get_outreach_dashboard");
  check("dashboard has a season and a queue", typeof dash0.season === "string" && Array.isArray(dash0.queue));

  // An org that takes requests by web form, and a deal with it.
  const org = await must("save_outreach_org", { name: `${TAG} Rocket Parts Co`, kind: "company", channel: "form", formUrl: "https://example.com/sponsor" });
  made.orgId = org.id;
  const deal = await must("save_sponsor", { orgId: org.id, type: "in_kind", ask: "two pressure transducers", valueCents: 50000 });
  made.dealId = deal.id;
  check("a new form-channel prospect is on the form queue", deal.attention?.kind === "form_to_submit", JSON.stringify(deal.attention));

  const person = await must("save_outreach_contact", { email: EMAIL.toUpperCase(), firstName: "Ada", lastName: "E2E", orgName: `${TAG} Rocket Parts Co`, tags: ["sponsor-contact"] });
  made.contactId = person.contact.id;
  check("email is normalized and the person joins the org", person.contact.email === EMAIL && person.contact.org?.id === org.id);

  // Outreach moves the stage and the follow-up clock.
  await must("log_outreach_touch", { kind: "email_sent", dealId: deal.id, contactId: person.contact.id, subject: `${TAG} ask`, followUpDays: 10 });
  let d = (await must("get_sponsor", { dealId: deal.id })).deal;
  const inDays = d.nextFollowUpAt ? Math.round((Date.parse(d.nextFollowUpAt) - Date.now()) / 86_400_000) : null;
  check("email sent: prospect → contacted, follow-up in 10 days", d.stage === "contacted" && inDays === 10, `${d.stage} ${inDays}`);
  await must("log_outreach_touch", { kind: "reply", dealId: deal.id, contactId: person.contact.id, note: `${TAG} they said yes-ish` });
  d = (await must("get_sponsor", { dealId: deal.id })).deal;
  check("reply: contacted → in talks, and it's our move", d.stage === "in_talks" && d.attention?.kind === "their_move", `${d.stage} ${d.attention?.kind}`);
  await must("schedule_sponsor_follow_up", { dealId: deal.id, days: 0 });
  d = (await must("get_sponsor", { dealId: deal.id })).deal;
  check("a follow-up due today is on the queue", d.attention?.kind === "follow_up_due", d.attention?.kind);
  const queued = await must("list_sponsors", { needsAttention: true });
  check("list_sponsors needsAttention includes it", queued.some((x) => x.id === deal.id));
  const saved = await must("save_sponsor", { dealId: deal.id, stage: "committed", theirDeliverables: "2 transducers" });
  check("save_sponsor updates and returns the deal", saved.stage === "committed" && saved.theirDeliverables === "2 transducers");

  // People, tags, lists.
  await must("tag_outreach_contacts", { contactIds: [person.contact.id], add: [TAG_SLUG], remove: [] });
  const found = await must("list_outreach_contacts", { filter: { tagsAny: [TAG_SLUG] } });
  check("list_outreach_contacts finds the tagged person", found.total === 1 && found.rows[0].email === EMAIL, String(found.total));
  const list = await must("save_outreach_list", { name: `${TAG} list`, filter: { tagsAny: [TAG_SLUG] } });
  made.listId = list.id;
  const lists = await must("list_outreach_lists");
  check("the saved list counts one address", lists.find((l) => l.id === list.id)?.count === 1);
  const emails = await must("get_outreach_list_emails", { listId: list.id });
  check("get_outreach_list_emails gives the BCC string", emails.count === 1 && emails.bcc === EMAIL, emails.bcc);
  const adhoc = await must("get_outreach_list_emails", { filter: { tagsAny: [TAG_SLUG], dealStages: ["committed"] } });
  check("ad-hoc filter by sponsor stage", adhoc.count === 1);
  const contact = await must("get_outreach_contact", { contactId: person.contact.id });
  check("get_outreach_contact has the history", contact.touches.length >= 2, String(contact.touches.length));

  // Templates and the merge.
  const tpl = await must("save_outreach_template", {
    name: `${TAG} template`,
    kind: "sponsor_followup",
    subject: "Following up: {{org}}",
    body: "Hi {{first_name|there}},\n{{#renewal}}Thanks again{{/renewal}}{{^renewal}}Thanks for considering us{{/renewal}}, {{org}}.\n{{sender_name}}",
  });
  made.templateId = tpl.id;
  const templates = await must("list_outreach_templates");
  check("list_outreach_templates includes it", templates.some((t) => t.id === tpl.id));
  const merge = await must("get_outreach_merge", { templateId: tpl.id, listId: list.id });
  const m0 = merge[0] ?? {};
  check(
    "merge renders per person with a Gmail compose link",
    merge.length === 1 && m0.body?.startsWith("Hi Ada,") && m0.subject === `Following up: ${TAG} Rocket Parts Co` && m0.missing?.length === 0 && m0.gmailUrl?.startsWith("https://mail.google.com/mail/?"),
    JSON.stringify(m0).slice(0, 200),
  );
  const mergeDeal = await must("get_outreach_merge", { templateId: tpl.id, dealId: deal.id });
  check("merge for one sponsor addresses its people", mergeDeal[0]?.to?.includes(EMAIL));
  const batch = await must("log_outreach_touches", { touches: [{ kind: "email_sent", contactId: person.contact.id, dealId: deal.id, templateId: tpl.id, subject: m0.subject }] });
  check("log_outreach_touches logs the merge as sent", batch.logged === 1);
  const starters = await must("install_outreach_starter_templates");
  check("starter templates install idempotently", typeof starters.added === "number");

  // A campaign, a gift imported from a ScaleFunder export, perks.
  const camp = await must("save_outreach_campaign", { name: `${TAG} campaign`, kind: "crowdfunding", goalCents: 100000, endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  made.campaignId = camp.id;
  const sheet = [
    "date_created,first_name,last_name,email,amount,perk_name,donor_display,sf_id",
    `2026-10-20 10:00:00,Ada,E2E,${EMAIL},$75.00,Signed Polaroid From Launch,display,E2E-${STAMP}`,
  ].join("\n");
  const preview = await must("import_outreach_sheet", { text: sheet, campaignId: camp.id });
  check("import dry run reads a ScaleFunder export and writes nothing", preview.preset === "scalefunder" && preview.summary.newDonations === 1);
  const committed = await must("import_outreach_sheet", { text: sheet, campaignId: camp.id, dryRun: false });
  check("import commits the gift onto the existing person", committed.donations === 1 && committed.contactsUpdated === 1, JSON.stringify(committed));
  const again = await must("import_outreach_sheet", { text: sheet, campaignId: camp.id, dryRun: false });
  check("re-importing the same export adds nothing", again.donations === 0);
  const campaign = await must("get_outreach_campaign", { campaignId: camp.id });
  check("campaign shows the gift with its perk pending", campaign.donations.length === 1 && campaign.donations[0].perkStatus === "pending");
  await must("set_outreach_perk_status", { donationIds: [campaign.donations[0].id], status: "sent" });
  const campaign2 = await must("get_outreach_campaign", { campaignId: camp.id });
  check("perk marked sent", campaign2.donations[0].perkStatus === "sent");
  const campaigns = await must("list_outreach_campaigns");
  check("list_outreach_campaigns totals the gift", campaigns.find((c) => c.id === camp.id)?.raisedCents === 7500);
  const donors = await must("get_outreach_list_emails", { filter: { donatedTo: camp.id } });
  check("a list of the campaign's donors", donors.count === 1);
  const dash = await must("get_outreach_dashboard");
  check("the dashboard counts the campaign's deadline", dash.milestones.some((x) => x.campaignId === camp.id));

  // Undo one touch.
  const hist = await must("get_sponsor", { dealId: deal.id });
  const note = hist.touches.find((t) => t.kind === "reply");
  await must("delete_outreach_touch", { touchId: note.id });
  const hist2 = await must("get_sponsor", { dealId: deal.id });
  check("delete_outreach_touch removes it", !hist2.touches.some((t) => t.id === note.id));

  // Validation errors come back as tool errors, not protocol failures.
  const bad = await call("save_outreach_contact", { email: "not an email" });
  check("a bad email is a readable tool error", !bad.ok && /email/i.test(bad.text), bad.text.slice(0, 120));
  const badStage = await call("save_sponsor", { dealId: deal.id, stage: "won" });
  check("an unknown stage is refused", !badStage.ok);

  if (memberToken) {
    const member = await connect(memberToken);
    for (const n of ["get_outreach_dashboard", "list_sponsors", "list_outreach_contacts", "get_outreach_list_emails", "list_outreach_campaigns"]) {
      const r = await call(n, n === "get_outreach_list_emails" ? { filter: {} } : {}, member);
      check(`non-admin refused: ${n}`, !r.ok && /admins only/i.test(r.text), r.text.slice(0, 80));
    }
    const w = await call("save_outreach_contact", { email: `x-${EMAIL}` }, member);
    check("non-admin refused: save_outreach_contact", !w.ok && /admins only/i.test(w.text));
    await member.close();
  } else {
    console.log("skip non-admin checks (set MCP_MEMBER_TOKEN)");
  }
} catch (e) {
  check("run", false, e.message);
} finally {
  // Clean up everything this run made.
  if (made.listId) await call("delete_outreach_list", { listId: made.listId });
  if (made.templateId) await call("delete_outreach_template", { templateId: made.templateId });
  if (made.campaignId) check("delete_outreach_campaign", (await call("delete_outreach_campaign", { campaignId: made.campaignId })).ok);
  if (made.dealId) check("delete_sponsor", (await call("delete_sponsor", { dealId: made.dealId })).ok);
  if (made.orgId) check("delete_outreach_org", (await call("delete_outreach_org", { orgId: made.orgId })).ok);
  if (made.contactId) check("delete_outreach_contacts", (await call("delete_outreach_contacts", { contactIds: [made.contactId] })).ok);
  const left = await call("list_outreach_contacts", { filter: { search: `mcp-e2e-${STAMP}`, includeExcluded: true } });
  check("nothing left behind", left.ok && left.data.total === 0);
  await client.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

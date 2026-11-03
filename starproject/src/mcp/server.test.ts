import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createStarProjectServer } from "./server";

// The registry, through the protocol: an in-memory client lists what a real
// client would see. No database is touched -- nothing runs a tool.

const ADMIN_ONLY = [
  "delete_task",
  "create_project",
  "update_project",
  "archive_project",
  "delete_project",
  "create_subteam",
  "update_subteam",
  "delete_subteam",
  "add_admin",
  "remove_admin",
  "set_featured",
  "set_phases",
  "untrack_subteam",
  "set_card_order",
  "run_email_batch",
  "run_deadline_scan",
  "run_digest",
  "list_email_queue",
  "list_notification_log",
  "get_outreach_dashboard",
  "list_sponsors",
  "get_sponsor",
  "save_sponsor",
  "save_outreach_org",
  "delete_outreach_touch",
  "delete_outreach_contacts",
  "log_outreach_touch",
  "schedule_sponsor_follow_up",
  "add_sponsor_task",
  "list_outreach_contacts",
  "get_outreach_contact",
  "save_outreach_contact",
  "tag_outreach_contacts",
  "list_outreach_lists",
  "get_outreach_list_emails",
  "save_outreach_list",
  "list_outreach_templates",
  "get_outreach_merge",
  "list_outreach_campaigns",
  "get_outreach_campaign",
  "save_outreach_campaign",
  "import_outreach_sheet",
  "log_outreach_touches",
  "delete_sponsor",
  "delete_outreach_org",
  "delete_outreach_campaign",
  "delete_outreach_list",
  "save_outreach_template",
  "delete_outreach_template",
  "set_outreach_perk_status",
];

const DESTRUCTIVE = [
  "delete_task",
  "delete_project",
  "delete_subteam",
  "delete_milestone",
  "remove_admin",
  "revoke_api_token",
  "untrack_subteam",
  "delete_outreach_touch",
  "delete_outreach_contacts",
  "delete_sponsor",
  "delete_outreach_org",
  "delete_outreach_campaign",
  "delete_outreach_list",
  "delete_outreach_template",
];

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

describe("MCP server registry", () => {
  let tools: Listed;
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStarProjectServer();
    await server.connect(serverTransport);
    client = new Client({ name: "registry-test", version: "0" });
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
  });

  it("registers the whole surface with unique snake_case names", () => {
    expect(tools.length).toBeGreaterThanOrEqual(50);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("gives every tool a description and behaviour hints", () => {
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
    }
  });

  it("marks reads read-only and destructive tools destructive", () => {
    for (const t of tools) {
      if (/^(list_|get_|my_|board$|gantt$|whoami$|health$|recent_)/.test(t.name)) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      }
    }
    for (const n of DESTRUCTIVE) {
      const t = tools.find((x) => x.name === n);
      if (t) expect(t.annotations?.destructiveHint, n).toBe(true);
    }
  });

  it("says 'admin' in the description of every admin-gated tool", () => {
    for (const n of ADMIN_ONLY) {
      const t = tools.find((x) => x.name === n);
      if (t) expect(t.description, n).toMatch(/admin/i);
    }
  });

  it("lists every outreach tool as admin-only (the CRM holds donors' details)", () => {
    const outreach = tools
      .map((t) => t.name)
      .filter((n) => /outreach|sponsor/.test(n));
    expect(outreach.length).toBeGreaterThanOrEqual(30);
    for (const n of outreach) expect(ADMIN_ONLY, n).toContain(n);
  });

  it("never lets a token mint another token", () => {
    expect(tools.some((t) => t.name === "create_api_token")).toBe(false);
    expect(tools.some((t) => t.name === "revoke_api_token")).toBe(true);
  });

  it("exposes the read-only resources", async () => {
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["starproject://projects", "starproject://me"]),
    );
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("starproject://tasks/{number}");
  });
});

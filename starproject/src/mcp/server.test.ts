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
];

const DESTRUCTIVE = ["delete_task", "delete_project", "delete_milestone", "remove_admin", "revoke_api_token", "untrack_subteam"];

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

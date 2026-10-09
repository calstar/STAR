#!/usr/bin/env node
// A real MCP client against the endpoint, for smoke tests and for checking a
// tool's output by hand.
//
//   node scripts/mcp-smoke.mjs <url> <token> list
//   node scripts/mcp-smoke.mjs <url> <token> call <tool> ['{"json":"args"}']
//   node scripts/mcp-smoke.mjs <url> <token> resources
//   node scripts/mcp-smoke.mjs <url> <token> read <uri>
//
// Exit code is 1 when a call returns isError, so it works in shell checks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token, command = "list", target, rawArgs] = process.argv.slice(2);
const COMMANDS = ["list", "call", "resources", "read"];
if (!url || !token || !COMMANDS.includes(command) || ((command === "call" || command === "read") && !target)) {
  console.error("usage: mcp-smoke.mjs <url> <token> list | call <tool> [json-args] | resources | read <uri>");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "starproject-smoke", version: "0.0.0" });
await client.connect(transport);

try {
  if (command === "list") {
    const { tools } = await client.listTools();
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      const ro = t.annotations?.readOnlyHint ? "read " : "write";
      console.log(`${ro}  ${t.name.padEnd(28)} ${t.description ?? ""}`);
    }
    console.error(`${tools.length} tools`);
  } else if (command === "call") {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const res = await client.callTool({ name: target, arguments: args });
    for (const c of res.content ?? []) {
      if (c.type === "text") console.log(c.text);
      else console.log(JSON.stringify(c));
    }
    if (res.isError) process.exitCode = 1;
  } else if (command === "resources") {
    const [{ resources }, { resourceTemplates }] = await Promise.all([
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    for (const r of resources) console.log(`${r.uri.padEnd(32)} ${r.description ?? ""}`);
    for (const t of resourceTemplates) console.log(`${t.uriTemplate.padEnd(32)} ${t.description ?? ""}`);
    console.error(`${resources.length} resources, ${resourceTemplates.length} templates`);
  } else {
    // A missing task number is a JSON-RPC error, not an isError result: print
    // its message and exit 1 the way a failed tool call does.
    try {
      const { contents } = await client.readResource({ uri: target });
      for (const c of contents) console.log("text" in c ? c.text : JSON.stringify(c));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
} finally {
  await client.close();
}

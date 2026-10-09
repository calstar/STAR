#!/usr/bin/env node
// A real MCP client against the endpoint, for smoke tests and for checking a
// tool's output by hand.
//
//   node scripts/mcp-smoke.mjs <url> <token> list
//   node scripts/mcp-smoke.mjs <url> <token> call <tool> ['{"json":"args"}']
//
// Exit code is 1 when a call returns isError, so it works in shell checks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token, command = "list", tool, rawArgs] = process.argv.slice(2);
if (!url || !token || !["list", "call"].includes(command) || (command === "call" && !tool)) {
  console.error("usage: mcp-smoke.mjs <url> <token> list | call <tool> [json-args]");
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
  } else {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const res = await client.callTool({ name: tool, arguments: args });
    for (const c of res.content ?? []) {
      if (c.type === "text") console.log(c.text);
      else console.log(JSON.stringify(c));
    }
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TOOL_MODULES } from "./tools";

export const SERVER_NAME = "starproject";
export const SERVER_VERSION = "1.0.0";

/**
 * A fresh server with every tool registered. The route builds one per request
 * (the transport is stateless), which is cheap: registration is a handful of
 * map inserts and nothing touches the database until a tool runs.
 */
export function createStarProjectServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "STARProject is the STAR Berkeley task tracker. Tools act as the user who owns the API token, " +
        "with the same permissions and audit trail as the web UI. Tasks have a global #number; projects " +
        "nest; subteams are tags. Admin-only tools say so in their description.",
    },
  );
  for (const register of TOOL_MODULES) register(server);
  return server;
}

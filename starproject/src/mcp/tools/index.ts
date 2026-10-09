import type { ToolModule } from "./_shared";
import { adminTools } from "./admins";
import { metaTools } from "./meta";
import { settingsTools } from "./settings";

// Every tool module the server registers. One line per module; a new area of
// the app adds its module here and documents its tools in docs/MCP.md.
export const TOOL_MODULES: ToolModule[] = [
  metaTools,
  settingsTools,
  adminTools,
];

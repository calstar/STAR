import type { ToolModule } from "./_shared";
import { metaTools } from "./meta";
import { opsTools } from "./ops";

// Every tool module the server registers. One line per module; a new area of
// the app adds its module here and documents its tools in docs/MCP.md.
export const TOOL_MODULES: ToolModule[] = [
  metaTools,
  opsTools,
];

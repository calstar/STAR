import type { ToolModule } from "./_shared";
import { adminTools } from "./admins";
import { metaTools } from "./meta";
import { tasksReadTools } from "./tasks-read";
import { tasksWriteTools } from "./tasks-write";
import { projectTools } from "./projects";
import { programTools } from "./program";
import { settingsTools } from "./settings";

// Every tool module the server registers. One line per module; a new area of
// the app adds its module here and documents its tools in docs/MCP.md.
export const TOOL_MODULES: ToolModule[] = [
  metaTools,
  tasksReadTools,
  tasksWriteTools,
  projectTools,
  programTools,
  settingsTools,
  adminTools,
];

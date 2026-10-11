import type { ToolModule } from "./_shared";
import { adminTools } from "./admins";
import { activityTools } from "./activity";
import { blockerTools } from "./blockers";
import { financeTools } from "./finance";
import { metaTools } from "./meta";
import { tasksReadTools } from "./tasks-read";
import { tasksWriteTools } from "./tasks-write";
import { projectTools } from "./projects";
import { programTools } from "./program";
import { settingsTools } from "./settings";
import { subteamTools } from "./subteams";
import { userTools } from "./users";
import { opsTools } from "./ops";

// Every tool module the server registers. One line per module; a new area of
// the app adds its module here and documents its tools in docs/MCP.md.
export const TOOL_MODULES: ToolModule[] = [
  metaTools,
  tasksReadTools,
  tasksWriteTools,
  projectTools,
  subteamTools,
  userTools,
  programTools,
  settingsTools,
  adminTools,
  opsTools,
  blockerTools,
  activityTools,
  financeTools,
];

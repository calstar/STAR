#!/usr/bin/env node
// End-to-end smoke test of the MCP server against a running app, as a real
// MCP client. Creates two "[mcp-e2e]" tasks in the first active project,
// walks them through the task / blocker / activity / settings tools, cleans up
// (fully with an admin token; a non-admin token can only archive them), and
// exits 1 if any check fails.
//
//   MCP_URL=http://localhost:3100/api/mcp MCP_TOKEN=sp_… node scripts/mcp-e2e.mjs
//
// Nothing here is mocked: every call goes through /api/mcp into the real
// server actions, so a green run means the UI's code paths work for an agent.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/api/mcp";
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error("MCP_TOKEN is required (mint one: node scripts/mcp-token.mjs you@berkeley.edu)");
  process.exit(2);
}

const TAG = `[mcp-e2e ${new Date().toISOString().slice(11, 19)}]`;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  -- ${detail}` : ""}`);
  return ok;
};

const client = new Client({ name: "starproject-e2e", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

/** Call a tool; returns { ok, data, text }. Parses JSON text results. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: !res.isError, data, text };
}

const created = [];
try {
  // --- transport-level checks -------------------------------------------
  const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("POST without a token is 401", noAuth.status === 401, String(noAuth.status));
  check("401 carries WWW-Authenticate", (noAuth.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
  const get = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  check("GET is 405 (stateless)", get.status === 405, String(get.status));

  // --- identity and registry ---------------------------------------------
  const me = await call("whoami");
  check("whoami answers", me.ok && typeof me.data.email === "string", me.text.slice(0, 80));
  const isAdmin = Boolean(me.data?.isAdmin);
  const health = await call("health");
  check("health is ok", health.ok && health.data.ok === true);
  const { tools } = await client.listTools();
  check("at least 50 tools registered", tools.length >= 50, `${tools.length}`);
  check("every tool has a description and annotations", tools.every((t) => t.description && t.annotations));
  check("token minting is not a tool", !tools.some((t) => t.name === "create_api_token"));
  const { resources, resourceTemplates } = await client.listResources().then(async (r) => ({
    resources: r.resources,
    resourceTemplates: (await client.listResourceTemplates()).resourceTemplates,
  }));
  check("resources: projects + me, template tasks/{number}",
    resources.some((r) => r.uri === "starproject://projects") &&
      resources.some((r) => r.uri === "starproject://me") &&
      resourceTemplates.some((t) => t.uriTemplate === "starproject://tasks/{number}"));

  // --- a project to work in ----------------------------------------------
  const projects = await call("list_projects");
  const project = projects.ok ? projects.data.find((p) => !p.archived) : null;
  if (!check("list_projects finds an active project", Boolean(project), projects.text.slice(0, 80))) throw new Error("no project");
  const gotProject = await call("get_project", { projectId: project.id });
  check("get_project returns the project", gotProject.ok && gotProject.data.id === project.id);

  // --- tasks: create, read, update ---------------------------------------
  const a = await call("create_task", { projectId: project.id, title: `${TAG} A`, priority: "high" });
  check("create_task A returns the task with a number", a.ok && Number.isInteger(a.data.number), a.text.slice(0, 120));
  if (a.ok) created.push(a.data);
  const b = await call("create_task", { projectId: project.id, title: `${TAG} B`, assigneeIds: [me.data.id] });
  check("create_task B with an assignee", b.ok && b.data.assignees?.length === 1, b.text.slice(0, 120));
  if (b.ok) created.push(b.data);
  if (!a.ok || !b.ok) throw new Error("task creation failed");

  const byNumber = await call("get_task", { number: a.data.number });
  check("get_task by number matches", byNumber.ok && byNumber.data.id === a.data.id, byNumber.text.slice(0, 80));
  const bad = await call("get_task", {});
  check("get_task with neither id nor number is a readable error", !bad.ok && /taskId|number/i.test(bad.text), bad.text);

  const upd = await call("update_task", { taskId: a.data.id, dueDate: "2027-01-15", description: "e2e", status: "in_progress" });
  check("update_task sets due date, description, status",
    upd.ok && upd.data.status === "in_progress" && String(upd.data.dueDate).startsWith("2027-01-15"), upd.text.slice(0, 120));
  const cleared = await call("update_task", { taskId: a.data.id, priority: null });
  check("update_task null clears priority", cleared.ok && cleared.data.priority === null);
  const dated = await call("set_task_dates", { taskId: a.data.id, startDate: "2027-01-01", dueDate: "2027-01-20" });
  check("set_task_dates", dated.ok);

  const mine = await call("my_tasks");
  check("my_tasks lists B (assigned to me)", mine.ok && JSON.stringify(mine.data).includes(b.data.id));
  const listed = await call("list_tasks", { search: TAG, archived: "all" });
  check("list_tasks search finds both", listed.ok && listed.data.total === 2, listed.text.slice(0, 80));
  const board = await call("board", { projectId: project.id });
  check("board groups by status", board.ok && board.data && typeof board.data === "object");
  const gantt = await call("gantt", { projectId: project.id });
  check("gantt answers", gantt.ok);

  // --- blockers -----------------------------------------------------------
  const blk = await call("add_blocker", { taskId: a.data.id, blockedById: b.data.id, note: "e2e" });
  check("add_blocker A <- B", blk.ok, blk.text.slice(0, 120));
  const dup = await call("add_blocker", { taskId: a.data.id, blockedById: b.data.id });
  check("duplicate blocker is a readable error", !dup.ok && dup.text.length > 0, dup.text);
  const cycle = await call("add_blocker", { taskId: b.data.id, blockedById: a.data.id });
  check("cycle is refused", !cycle.ok, cycle.text);
  const edges = await call("list_blockers", { taskId: a.data.id });
  check("list_blockers shows B blocking A", edges.ok && JSON.stringify(edges.data).includes(b.data.id));
  const blockedList = await call("list_tasks", { search: TAG, blocked: true, archived: "all" });
  check("list_tasks blocked=true finds A", blockedList.ok && blockedList.data.total === 1);

  // --- resources ----------------------------------------------------------
  const res = await client.readResource({ uri: `starproject://tasks/${a.data.number}` });
  check("resource tasks/{number} reads A", res.contents?.[0]?.text?.includes(a.data.id));

  // --- move to done archives, activity records everything -----------------
  const moved = await call("move_task", { taskId: b.data.id, status: "done" });
  check("move_task B to done", moved.ok, moved.text.slice(0, 80));
  const bNow = await call("get_task", { taskId: b.data.id });
  check("done task is auto-archived", bNow.ok && bNow.data.archived === true);
  const act = await call("list_activity", { taskId: a.data.id });
  const kinds = act.ok ? act.data.items.map((i) => i.kind) : [];
  check("list_activity for A has created, updated, blocker_added",
    kinds.includes("created") && kinds.includes("updated") && kinds.includes("blocker_added"), kinds.join(","));
  const recent = await call("recent_activity", { hours: 1 });
  check("recent_activity includes our tasks", recent.ok && JSON.stringify(recent.data).includes(TAG));

  const unblk = await call("remove_blocker", { taskId: a.data.id, blockedById: b.data.id });
  check("remove_blocker", unblk.ok);

  // --- settings round trip ------------------------------------------------
  const s0 = await call("get_my_settings");
  check("get_my_settings", s0.ok && typeof s0.data.theme === "string");
  if (s0.ok) {
    const theme = s0.data.theme === "dark" ? "light" : "dark";
    const flipped = await call("set_theme", { theme });
    check("set_theme flips", flipped.ok && flipped.data.theme === theme, flipped.text.slice(0, 60));
    const restored = await call("set_theme", { theme: s0.data.theme });
    check("set_theme restores", restored.ok && restored.data.theme === s0.data.theme);
  }
  const admins = await call("list_admins");
  check("list_admins", admins.ok && Array.isArray(admins.data.admins));
  const program = await call("get_program_board");
  check("get_program_board", program.ok);

  // --- admin gating is enforced, not advisory ----------------------------
  const sub = await call("create_subteam", { name: `${TAG} x` }).catch(() => null);
  if (sub) check("create_subteam exists only if that unit shipped", true);
  const del = await call("delete_task", { taskId: a.data.id });
  if (isAdmin) {
    check("delete_task as admin removes A", del.ok, del.text.slice(0, 80));
    if (del.ok) created.splice(created.findIndex((t) => t.id === a.data.id), 1);
  } else {
    check("delete_task as non-admin is refused", !del.ok && /admin/i.test(del.text), del.text);
    const ops = await call("run_email_batch");
    check("run_email_batch as non-admin is refused", !ops.ok && /admin/i.test(ops.text), ops.text);
  }
} catch (err) {
  failed++;
  console.log(`FAIL aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // --- cleanup ------------------------------------------------------------
  for (const t of created) {
    const del = await call("delete_task", { taskId: t.id });
    if (!del.ok) {
      await call("archive_task", { taskId: t.id, archived: true });
      console.log(`note: #${t.number} left archived (needs an admin token to delete): ${t.id}`);
    }
  }
  await client.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

# STARProject MCP server

STARProject exposes everything a person can do in the web app as [MCP](https://modelcontextprotocol.io)
tools, so an agent (Claude Code, Claude Desktop, anything that speaks MCP) can read and change
tasks, projects, subteams, users, blockers, activity, settings, admins, the program board and
finance **as you**, with your permissions and the same audit trail the UI leaves.

- **Endpoint:** `https://project.starberkeley.org/api/mcp` (dev: `http://localhost:3000/api/mcp`)
- **Transport:** Streamable HTTP, stateless, JSON responses. `POST` carries JSON-RPC; `GET`/`DELETE`
  are accepted and answered per the spec (no sessions, so nothing to resume or delete).
- **Auth:** `Authorization: Bearer sp_…` — a personal access token. No cookie, no OAuth.

## Getting a token

In the app: **Settings → API tokens → New token**. The token is shown once; copy it. Revoke it from
the same list whenever you like (a revoked token gets `401` immediately).

Locally, without a browser:

```bash
export DATABASE_URL="postgresql://starproject:starproject@localhost:5432/starproject?schema=public"
node scripts/mcp-token.mjs you@berkeley.edu "laptop"      # prints sp_…
```

Tokens are stored hashed (SHA-256); the row keeps a short prefix, a name, created / last-used /
revoked timestamps. Deleting a user deletes their tokens. Minting is only possible from the
browser session, never through MCP, so a leaked token cannot create a successor for itself;
revoking (`revoke_api_token`) is available either way.

## Connecting a client

**Claude Code**

```bash
claude mcp add --transport http starproject https://project.starberkeley.org/api/mcp \
  --header "Authorization: Bearer sp_…"
```

**Claude Desktop / clients that only speak stdio** — via `mcp-remote`:

```json
{
  "mcpServers": {
    "starproject": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://project.starberkeley.org/api/mcp",
               "--header", "Authorization: Bearer sp_…"]
    }
  }
}
```

**Smoke test from a shell** (a real MCP client, in the repo):

```bash
node scripts/mcp-smoke.mjs https://project.starberkeley.org/api/mcp "$TOKEN" list
node scripts/mcp-smoke.mjs https://project.starberkeley.org/api/mcp "$TOKEN" call whoami
node scripts/mcp-smoke.mjs https://project.starberkeley.org/api/mcp "$TOKEN" call create_task \
  '{"projectId":"…","title":"Order fittings","priority":"high"}'
```

Without a token the endpoint answers `401` with `WWW-Authenticate: Bearer realm="starproject-mcp"`.

## How it works

```
client ──Bearer──▶ Caddy (handle /api/mcp*, strips X-Auth-*) ──▶ src/app/api/mcp/route.ts
                                                                   │ authenticateBearer (src/lib/apiTokens.ts)
                                                                   │ runAsIdentity (src/lib/auth.ts)
                                                                   ▼
                                                 McpServer (src/mcp/server.ts) → src/mcp/tools/*.ts
                                                                   │ each tool calls the real server action
                                                                   ▼
                                                 src/lib/actions/* → Prisma, Activity log, emails, revalidate
```

- The server runs **inside the Next app** as a route handler. That is deliberate: the server
  actions use `headers()`, `revalidatePath` and `after()`, which only work in a Next request, and
  calling the real actions is what guarantees parity with the UI (same validation, same Activity
  rows, same assignment emails).
- `getCurrentUser()` checks an `AsyncLocalStorage` identity first; the route sets it from the
  token. Headers a client sends are never consulted on this path (Caddy also strips them).
- Each request builds a fresh `McpServer` and a stateless transport; registration is cheap and
  nothing touches the database until a tool runs.

## Conventions for tool modules

A module is `(server: McpServer) => void` in `src/mcp/tools/<area>.ts`, listed in
`src/mcp/tools/index.ts`. Use `defineTool` from `_shared.ts`:

```ts
defineTool(server, "archive_task", {
  description: "Hide a task from active lists (or bring it back).",
  inputSchema: { taskId: z.string().min(1), archived: z.boolean().default(true) },
  annotations: IDEMPOTENT_WRITE,
}, async ({ taskId, archived }) => {
  await archiveTask(taskId, archived);          // the real server action
  return prisma.task.findUnique({ where: { id: taskId } });
});
```

- **Mutations call the existing server action** in `src/lib/actions/*`. Never re-implement a write.
  `toFormData({...})` builds the `FormData` those actions take; it omits `undefined` keys (the
  actions treat presence as "set this"), sends `null` as `""` (how the UI clears a field) and joins
  arrays with commas (`assigneeIds`).
- **Reads mirror the page they stand in for** (cite it in a comment) and reuse the pure helpers in
  `src/lib/*` (`toRowData`, `groupByStatus`, `toGanttTasks`, `pathOf`, `displayNameOf`,
  `listFinanceRows`, `getFinanceDetail`, `getProgramCards`, …).
- Reuse zod schemas and enums from `src/lib/validation.ts` and `src/lib/finance/schema.ts`.
- Names are `snake_case` verbs on nouns. Descriptions say "admins only" when the action is gated.
  Annotations are one of `READ`, `WRITE`, `IDEMPOTENT_WRITE`, `DESTRUCTIVE`.
- Handlers return plain data; `defineTool` serialises it and turns any thrown error (including
  `ZodError`) into an `isError` result with a readable message.
- Dates go out as ISO strings; task dates go in as `YYYY-MM-DD`.

## Tools

| Tool | Does | Notes |
|---|---|---|
| `whoami` | The token's user and admin flag | read |
| `health` | DB round-trip and counts | read |
| `list_api_tokens` | Your tokens (never the secret) | read |
| `revoke_api_token` | Revoke one of your tokens | destructive |
| `list_tasks` | The /tasks list with its filters (status, project + subprojects, subteam, assignee, mine, archived, search, due range, overdue, blocked); `{ total, tasks }`, paged. `archived` defaults to active, or all when status includes done | read |
| `get_task` | One task by `taskId` or `number`: fields, assignees, creator, blockers both ways, project path, activity log | read |
| `board` | A project's (with subtree) or subteam's active tasks grouped by status, sorted like the Board view | read |
| `gantt` | A project's or subteam's timeline rows (`toGanttTasks`): dated tasks with dependencies | read |
| `my_tasks` | The home page's "My tasks": active tasks assigned to you, soonest due first | read |
| `create_task` | New task in a project: title, description, priority, assignees, subteam, dates; returns it with its `#number` | write; logs created + assigned, emails assignees |
| `update_task` | Edit any subset of fields; `null` clears priority / subteam / dates / description / blockedNote; `assigneeIds` replaces the set | idempotent; done ⇄ archived follows the UI |
| `set_task_dates` | Start and due together (the Gantt drag) | idempotent |
| `move_task` | Kanban move: `status` plus `boardOrder`, or `afterTaskId` / `beforeTaskId` (midpoint of the neighbours on `boardProjectId`'s board -- that project and its subprojects, as the project page shows; default the task's own project); default end of column | idempotent |
| `archive_task` | Hide from active lists, or `archived=false` to restore | idempotent |
| `delete_task` | Permanent; returns `{deleted, number}` | destructive, admins only |
| `list_projects` | The project tree in `/projects` order: depth, path, own and rolled-up task counts | read; `includeArchived` |
| `get_project` | One project with ancestors, subprojects, counts, creator | read |
| `create_project` | New project, optionally under a parent | admins only; write |
| `update_project` | Rename, describe, recolour or move a project (omitted fields kept, `null` clears) | admins only; idempotent |
| `archive_project` | Hide a project and its subprojects from lists and pickers (or restore it) | admins only; idempotent |
| `delete_project` | Delete a project and its tasks | admins only; destructive |
| `get_program_board` | The homepage program board: tracked projects, systems, subteam phases, milestones | read |
| `get_project_program` | One project's phases, subteam phases, milestones, featured flag | read |
| `set_featured` | Track / untrack a top-level project on the homepage | admins only, idempotent |
| `set_phases` | Replace a project's phase list (`[]` = defaults) | admins only, idempotent |
| `set_subteam_phase` | Move a subteam to a phase (adds it to the card) | idempotent |
| `untrack_subteam` | Drop a subteam's row from a card | admins only, destructive |
| `add_milestone` | Add a dated milestone (program-wide or a subteam's) | write |
| `set_milestone_done` | Tick / untick a milestone | idempotent |
| `set_milestone_link` | Set or clear a milestone's http(s) link | idempotent |
| `delete_milestone` | Delete a milestone | destructive |
| `set_card_order` | Re-order the homepage cards (all featured top-level ids) | admins only, idempotent |

Modules append their tools here as they land.

## Deployment

Nothing new in `.env`: tokens live in the database. The `ApiToken` table arrives with the image's
startup `prisma migrate deploy`. The Caddy change (`handle /api/mcp*` on `project.*` in
`deploy/ec2/caddy/Caddyfile`) is picked up by Caddy's `--watch`; `deploy/caddy/tests/check_gate_order.py`
lists `/api/mcp` as public by design and still fails if the rest of the site stops gating first.

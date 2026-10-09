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

**Lifecycle.** A token never expires on its own; it ends when you revoke it. `lastUsedAt` is
refreshed as the token is used (at most once a minute, to spare the database), so a token you
don't recognise in the list can be judged by when it was last used. To rotate: mint the new one (`create_api_token` or Settings → API
tokens), move your clients over, then `revoke_api_token` the old one -- revocation is immediate,
and revoking the token a session is using ends that session on its next request. There is no
"re-show" of a token; a lost token is a revoke-and-mint.

## Connecting a client

**Claude Code**

```bash
claude mcp add --transport http starproject https://project.starberkeley.org/api/mcp \
  --header "Authorization: Bearer sp_…"
```

**Claude Desktop** (and any client that only speaks stdio) — via `mcp-remote`, in
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`); restart Claude Desktop after saving:

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
node scripts/mcp-smoke.mjs https://project.starberkeley.org/api/mcp "$TOKEN" resources
node scripts/mcp-smoke.mjs https://project.starberkeley.org/api/mcp "$TOKEN" read starproject://tasks/12
```

**Raw JSON-RPC with curl** -- the transport is stateless, so a single `POST` is a complete
exchange; no `initialize` handshake is needed. The `Accept` header must offer both media types
or the server refuses the request with `406`:

```bash
curl -s https://project.starberkeley.org/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Swap the body for `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`
to call a tool, or `{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"starproject://me"}}`
to read a resource.

Without a token the endpoint answers `401` with `WWW-Authenticate: Bearer realm="starproject-mcp"`.

## Running locally

The MCP endpoint is part of the Next app, so `npm run dev` serves it at
`http://localhost:3000/api/mcp` (set `PORT` to move it). It needs `DATABASE_URL`; the
`DEV_AUTH_*` fallbacks are for the browser UI and are never consulted on this path.

```bash
cd starproject
export DATABASE_URL="postgresql://starproject:starproject@localhost:5432/starproject?schema=public"
TOKEN=$(node scripts/mcp-token.mjs you@berkeley.edu "laptop")   # mints straight into the DB
npm run dev &
node scripts/mcp-smoke.mjs http://localhost:3000/api/mcp "$TOKEN" list
node scripts/mcp-smoke.mjs http://localhost:3000/api/mcp "$TOKEN" call whoami
node scripts/mcp-smoke.mjs http://localhost:3000/api/mcp "$TOKEN" resources
node scripts/mcp-smoke.mjs http://localhost:3000/api/mcp "$TOKEN" read starproject://projects
```

- `scripts/mcp-token.mjs <email> [name]` upserts the user and mints a token in the same format
  `src/lib/apiTokens.ts` uses (`sp_` + 32 random bytes, stored as SHA-256), printing it once.
- `scripts/mcp-smoke.mjs <url> <token> list | call <tool> [json] | resources | read <uri>` is a
  real MCP client; its exit code is 1 when a tool call returns `isError`, so it works in
  shell checks.
- Admin-only tools answer `Forbidden: admins only` unless the token's owner is in
  `src/lib/admins.ts` (or added under Workspace setup → Admins); your dev identity usually
  isn't, so expect that refusal locally for the ops tools.
- The unit tests (`npm test`) cover the pure helpers only; nothing in them needs a database or
  a running server.

### Test suites

- `npm test` includes `src/mcp/server.test.ts`: an in-memory MCP client lists the registry and checks
  every tool has a description and behaviour hints, names are unique, reads are read-only,
  destructive tools say so, admin-gated tools say "admin", and no tool can mint a token.
  No database is touched.
- `npm run mcp:e2e` (`scripts/mcp-e2e.mjs`) is the live smoke test: with `MCP_URL` and `MCP_TOKEN`
  set it drives a real client through 401/405, whoami, projects, two `[mcp-e2e]` tasks (create,
  read by number, update, clear, dates), blockers (add, duplicate, cycle, list, remove), the
  `tasks/{number}` resource, move-to-done auto-archive, activity, settings round trip, the program
  board, and admin gating. It deletes its tasks with an admin token; a non-admin token can only
  archive them, and the script prints their ids. Exit code 1 on any failed check.

```bash
MCP_URL=http://localhost:3100/api/mcp MCP_TOKEN=$(node scripts/mcp-token.mjs you@berkeley.edu e2e) npm run mcp:e2e
```

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

## Security

- **Tokens are hashed.** Only the SHA-256 of a token is stored (`ApiToken.tokenHash`), with an
  8-character prefix for display. A database read cannot recover a token; neither can the app
  after the one time it shows it.
- **Revocation is immediate.** Every request looks the token up; a revoked (or deleted) token
  gets `401` on its very next call, with no cache to wait out.
- **The token is the only identity on this path.** Caddy routes `/api/mcp*` around the
  `forward_auth` gate and strips any `X-Auth-*` headers the client sent, and `getCurrentUser()`
  checks the token identity before it reads headers at all. A client cannot name someone else by
  adding a header.
- **A token acts as its owner.** Every tool and resource runs as the user who minted it, with
  that user's permissions: the same flat model as the UI (everyone reads and edits everything),
  the same `Activity` rows, the same assignment emails. Treat a token like a password to your
  account.
- **Admins-only tools say so** in their description and refuse with `Forbidden: admins only`
  for anyone else; the gate is `src/lib/admins.ts`, the same one the UI's destructive actions
  use. The ops tools (`run_email_batch`, `run_deadline_scan`, `run_digest`, `list_email_queue`,
  `list_notification_log`) are all admin-gated.
- **Rotate with `create_api_token` / `revoke_api_token`** (or Settings → API tokens). Mint the
  replacement first, then revoke the old one; `list_api_tokens` shows last-used times so a
  stray token is easy to spot.

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
| `get_my_settings` | Your Settings page: name, theme, email prefs, digest kinds, followed projects/subteams (+ the followable ones and kind options) | read |
| `set_theme` | `light` or `dark` | idempotent; returns refreshed settings |
| `set_display_name` | Your shown name (≤60 chars; `""` clears to "First L.") | idempotent; returns refreshed settings |
| `set_email_pref` | One of `emailAssignments`, `emailDueSoon`, `emailOverdue` on/off | idempotent; returns refreshed settings |
| `set_digest_kind` | Include/exclude a `DIGEST_KINDS` key from your nightly digest | idempotent; kind validated by zod enum |
| `toggle_digest_project` | Follow/unfollow a project for the digest | toggle; returns `following` + settings |
| `toggle_digest_subteam` | Follow/unfollow a subteam for the digest | toggle; returns `following` + settings |
| `list_admins` | Effective admins, each marked `seed` or added, plus your `isAdmin` | read |
| `add_admin` | Grant admin to an email | admins only |
| `remove_admin` | Revoke admin (seed admins are tombstoned); refuses to remove the last admin | admins only; destructive |
| `run_email_batch` | Flush the assignment-email queue (what the 15-minute cron does) | admins only; no-op without `SES_FROM` |
| `run_deadline_scan` | Email overdue / due-soon assignees, once per (task, user, kind) | admins only; no-op without `SES_FROM` |
| `run_digest` | Send the nightly activity digest to followers | admins only; no-op without `SES_FROM` |
| `list_email_queue` | Unsent `EmailQueueItem`s: recipient, kind, task title, queued at | admins only; read |
| `list_notification_log` | Recent `NotifLog` rows (deadline emails sent), labelled with task and recipient | admins only; read |
| `add_blocker` | Mark a task blocked by another task in its project, optional note | write; rejects self, cross-project, duplicate, cycle |
| `remove_blocker` | Unlink a blocker edge | idempotent; `removed: false` when there was none |
| `list_blockers` | By `taskId`: blocked-by and blocking lists; by `projectId`: every edge (the Gantt arrows) | read |
| `list_activity` | The audit log with the `/activity` filters (kind, actor, project) plus task and `since`/`until`, paged | read; each item has a `summary` line |
| `recent_activity` | The last N hours (default 24, max 168), the digest's view, optional project / subteam | read |
| `list_reimbursements` | The Finance table, newest first, with the page's filters: `status` (a display-status key), `mine`, `review` (needs an admin), `search` | read |
| `get_reimbursement` | One reimbursement by R-number: fields, items + receipts, timeline, `can`; PII and receipt links redacted unless you are the payee, the filer or an admin | read |
| `get_payee_defaults` | What the New reimbursement form pre-fills for you (saved profile, else your newest CalLink request, else account) | read |
| `file_reimbursement` | File a reimbursement like the form: the form's fields plus `receipts` (base64 PDF/PNG/JPEG, one per item, under 4 MB); lands as `pending_approval` | write; same code path as `POST /api/finance/requests` |
| `approve_reimbursement` | Queue a pending reimbursement for the CalLink worker | admins only; write |
| `reject_reimbursement` | Reject a pending reimbursement with a reason (≤1000 chars) | admins only; destructive (final) |
| `retry_reimbursement` | Put a failed filing back in the queue | admins only; write |
| `cancel_reimbursement` | Cancel before it reaches CalLink: the filer while pending, an admin also when approved or failed | destructive (final) |
| `resolve_needs_check` | Record whether a filing the worker could not confirm is on CalLink (`filed`) | admins only; write |
| `request_callink_login` | Ask callink-worker to sign in to CalLink (sends the Duo push) | admins only; write |
| `get_worker_status` | The CalLink worker's last report and the sign-in banner state | admins only; read |

Modules append their tools here as they land.

## Resources

Read-only context a client can pull without calling a tool (`resources/list`,
`resources/templates/list`, `resources/read`). Every body is JSON (`application/json`).

| URI | Body |
|---|---|
| `starproject://projects` | The whole project tree in display order: `id`, `name`, `path` ("LE4 › Engine › Spark igniter"), `depth`, `parentId`, `color`, `archived`. Archived projects are included and flagged. |
| `starproject://tasks/{number}` | One task by its global `#number`: fields, project (with path), subteam, assignees (with `displayName`), and the tasks blocking it. An unknown number is a JSON-RPC error (`No task #N`). |
| `starproject://me` | The token's owner, the same object `whoami` returns. |

They live in `src/mcp/resources.ts`, registered from `createStarProjectServer` after the tool
modules.

## Deployment

Nothing new in `.env`: tokens live in the database. The `ApiToken` table arrives with the image's
startup `prisma migrate deploy`. The Caddy change (`handle /api/mcp*` on `project.*` in
`deploy/ec2/caddy/Caddyfile`) is picked up by Caddy's `--watch`; `deploy/caddy/tests/check_gate_order.py`
lists `/api/mcp` as public by design and still fails if the rest of the site stops gating first.

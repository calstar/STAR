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
revoked timestamps. Deleting a user deletes their tokens.

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
| `create_api_token` | Mint a token for yourself | shown once |
| `revoke_api_token` | Revoke one of your tokens | destructive |

Modules append their tools here as they land.

## Deployment

Nothing new in `.env`: tokens live in the database. The `ApiToken` table arrives with the image's
startup `prisma migrate deploy`. The Caddy change (`handle /api/mcp*` on `project.*` in
`deploy/ec2/caddy/Caddyfile`) is picked up by Caddy's `--watch`; `deploy/caddy/tests/check_gate_order.py`
lists `/api/mcp` as public by design and still fails if the rest of the site stops gating first.

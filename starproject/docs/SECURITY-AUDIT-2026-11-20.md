# STARProject security audit, 2026-11-20

Scope: the whole `starproject` app at commit `215b33af` (pages, server actions, API
routes, the MCP server and its 139 tools, the OAuth issuer, the worker and cron
APIs, the Docker image) plus the EC2 Caddy gate and compose stack that front it.

Method: every route and action was read for its authorization check; every finding
below was then tried against a local instance (`npm run dev:local` on :3100, embedded
Postgres) with an MCP token minted for a plain member (`member@berkeley.edu`, not an
admin, not a PVP) and one for the seeded admin. `npm audit` for dependencies.

## The reported escalation does not reproduce

The report that prompted this audit was that a regular member can make themselves an
admin or a PVP through the MCP. At this commit that is not so. As the member token:

| call | answer |
|---|---|
| `add_admin {email: member@berkeley.edu}` | `Forbidden: admins only` |
| `remove_admin {email: dev@berkeley.edu}` | `Forbidden: admins only` |
| `add_pvp {email: member@berkeley.edu}` | `Only a PVP can do that.` |
| `remove_pvp {email: dev@berkeley.edu}` | `Only a PVP can do that.` |
| `whoami` afterwards | `isAdmin: false, isPvp: false` |

Nor is the admin list cached across requests: inserting an `AdminEmail` row for the
member made the next `whoami` say admin, and deleting it made the one after say not.
Every other admin- or PVP-gated tool refused the member as well (`create_project`,
`update_project`, `archive_project`, `create_subteam`, `delete_task`, task `points`,
`set_phases`, `run_digest`, `list_email_queue`, `get_finance_overview`,
`list_reimbursements`, `get_reimbursement_receipts`, `create_receipt_upload`,
`request_callink_login`, `get_outreach_dashboard`, `approve_purchase_request`, BOM
approval and demotion, `delete_bom_item` on an approved line, revoking someone else's
token).

Two things in the code do explain how a member could appear to grant themselves admin:

1. **`ucberkeleystar@gmail.com` is a seed admin, a seed PVP, and the one address the
   shared login lets in** (`src/lib/admins.ts`, `src/lib/pvp.ts`, `OUTSIDE_EMAILS` in
   `auth/main.py`). Anyone who knows that shared Gmail password is a full admin and PVP
   and can add their own address through `add_admin` / `add_pvp` or Workspace setup.
   That is a real privilege-escalation path; it is a roster decision, not a code bug,
   so it is not changed here. **Recommendation:** take the shared account out of
   `SEED_ADMIN_EMAILS` (an admin can also tombstone it from Workspace setup today)
   and decide whether it should stay a PVP.
2. `rtaneja@berkeley.edu` is itself a seed admin, so a test run with that account's
   own token succeeds legitimately.

If the escalation was seen with some other account, the token and the time matter:
the `Activity` log and `ApiToken.lastUsedAt` will say which token did it.

## Findings

| # | severity | finding | status |
|---|---|---|---|
| 1 | medium | `/api/cron/*` ran with no secret when `CRON_SECRET` was unset; compose defaults it to empty | fixed |
| 2 | medium | any container on the compose network can set `X-Auth-Email` and act as any user | opt-in fix shipped |
| 3 | medium | no anti-framing headers; the OAuth consent page could be clickjacked into an Allow | fixed |
| 4 | high (deps) | Next 15.5.24 carried a critical advisory set; 27 advisories, 1 critical, 11 high | fixed (9 left, all majors) |
| 5 | low | outreach link fields stored any scheme and rendered as `<a href>` (admin-to-admin `javascript:` XSS) | fixed |
| 6 | low | `DEV_AUTH_EMAIL` fallback honoured in production builds | fixed |
| 7 | low | `updateTask` stored unbounded description / blocked note; `setDigestKind` stored any string | fixed |
| 8 | hardening | admin and PVP roster tools gated only in the action layer | guarded in the MCP layer too, e2e asserts refusal |
| 9 | process | shared purchasing Gmail is seed admin + seed PVP | recommended, not changed |
| 10 | low | any member may set a display name that reads as someone else, e.g. "Aidan Rickert (admin)" | recommended |
| 11 | low | `fileReimbursement` lets any member re-point any BOM line's `reimbursementId` | recommended |
| 12 | low | `/oauth/register` is public and unbounded; clients are never cleaned up | recommended |
| 13 | low | the Docker image runs as root | recommended |

### 1. Cron routes failed open (fixed)

`src/app/api/cron/{deadlines,digest,email-batch}/route.ts` checked the
`x-cron-secret` header only `if (secret)`. With `CRON_SECRET` unset they ran for
anyone, and `deploy/ec2/docker-compose.yml` sets it to `${STARPROJECT_CRON_SECRET:-}`,
so a missing `.env` line left them open to every signed-in member (the routes sit
behind the cookie gate, but a member has the cookie) and to every container on the
compose network. Verified locally: `POST /api/cron/digest` with no header returned
`200 {"emails":0}`.

Fix: all three use `internalSecretOk` (constant-time, refuses when the secret is unset),
the same helper `/api/internal/admins` already used. `src/app/api/cron/cron-auth.test.ts`
holds them to it (red against the old routes, green now). **Deploy note:** if the
production `.env` lacks `STARPROJECT_CRON_SECRET`, scheduled emails stop until it is
set; the admin MCP tools `run_digest` / `run_deadline_scan` / `run_email_batch` are the
manual fallback.

### 2. Header identity trusted from any network peer (opt-in fix)

`getCurrentUser` trusted `X-Auth-Email` unconditionally. Caddy strips a client-sent
copy and sets it from `/verify`, so the internet path is sound. On the compose
network, though, `starproject:3000` is reachable directly by `callink-worker`,
`starproject-cron`, `cloudflared` and the **internet-facing analytics hub**, and any
of them could name any admin in a header. A compromise of the hub would be a full
takeover of the tracker.

Fix: `identityFromHeaders` in `src/lib/auth.ts`. When `AUTH_GATE_SECRET` is set, the
headers count only on a request that also carries `X-Auth-Gate` equal to it; the EC2
Caddyfile strips a client-sent `X-Auth-Gate` before `forward_auth` and sets it after
(`request_header X-Auth-Gate {$AUTH_GATE_SECRET}`), and compose passes
`STARPROJECT_AUTH_GATE_SECRET` to both containers. Unset, nothing changes. The adapted
Caddy config was checked (`caddy validate`, `check_gate_order.py`, and the handler
order: strip, forward_auth, set, proxy). `src/lib/auth.test.ts` covers the seam.
**Deploy note:** set the variable in `.env` to turn it on; set it on both services or
neither.

### 3. No anti-framing or sniffing headers (fixed)

`next.config.ts` sent none. The concrete risk is the OAuth consent page
(`/oauth/authorize`): framed on an attacker's page, a tricked click on Allow sends a
code to a registered redirect, and with claude.ai's callback and the attacker's own
`state` that is a token for the victim. Now every response carries
`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`
(verified with `curl -I`). A full CSP and HSTS were left out: Cloudflare terminates TLS,
and the app's inline styling would need a nonce scheme first.

### 4. Dependencies (fixed as far as semver allows)

`npm audit` before: 27 advisories (1 critical, 11 high, 15 moderate). The critical set
was Next 15.5.24 (SSG/ISR cache poisoning, image-optimizer SVG RCE, Server Actions
DoS, cross-client response injection). After `next@15.5.29`, `eslint-config-next`,
`npm audit fix` and `npm update brace-expansion`: 9 advisories, none critical, and every
one needs a major version:

- `prisma` CLI (via `@prisma/config` → `deepmerge-ts`, `effect`): fix is Prisma 7.
  `npm audit fix` had quietly downgraded the CLI to 6.12.0 against a 6.19.3 client;
  it is pinned back to 6.19.3.
- `next` moderate + the `postcss` copy Next bundles: fix is Next 16.
- `zod` memory exhaustion on oversized collections: fix is zod 4 (the MCP SDK and every
  schema here are on 3).
- `exceljs` → `uuid`: the "fix" is a downgrade to exceljs 3.4.

Build (standalone), typecheck, lint and the 535 unit tests pass on the new set, and the
live MCP e2e (`scripts/mcp-e2e.mjs`) passes as both the member and the admin.

### 5. Outreach links accepted any scheme (fixed)

`website`, `formUrl`, `threadUrl` and campaign `url` in `src/lib/actions/outreach.ts`
were `optText`, and the pages render each as `<a href>`. React does not block a
`javascript:` href, so an admin could plant one for another admin. BOM, manufacturing
and milestone links already refused anything but http(s); outreach now does too, through
the same `cleanLink`. MCP tool schemas and `docs/MCP.md` say so.

### 6. Dev identity fallback in production (fixed)

`DEV_AUTH_EMAIL` / `DEV_AUTH_NAME` were honoured whatever `NODE_ENV` was. A stray
variable on the server would have made every header-less request that user. The
fallback now applies only outside production (`src/lib/auth.test.ts`).

### 7. Unbounded writes (fixed)

`updateTask` accepted any length for `description` and `blockedNote` while
`createTask` capped the description at 5000; both are now capped at 5000, matching the
MCP `update_task` schema. `setDigestKind` stored any string in `digestKinds`; it now
refuses a kind the digest does not know (the MCP tool already enumerated them).

### 8. Roster tools guarded twice (hardening)

`add_admin` / `remove_admin` now run under `guardedDefine(server, requireAdmin)` and
`add_pvp` / `remove_pvp` under the module's existing `pvpOnly`, on top of the checks in
the actions, so a later change to an action cannot quietly open the roster to every
token. `scripts/mcp-e2e.mjs` now asserts, with a non-admin token, that all four refuse
and that `whoami` is unchanged afterwards (46 checks pass as the member, 40 as the admin).

### Recommended, not changed

- **9. Shared account as seed admin/PVP.** See above. Remove it from
  `SEED_ADMIN_EMAILS`; keep a named person as the PVP of record.
- **10. Display-name impersonation.** `setDisplayName` takes any 60 characters; a member
  can show as "Aidan Rickert (admin)" in every picker and activity row (verified over
  MCP). Options: show the email on hover everywhere, or refuse a display name that
  equals another user's name.
- **11. BOM line re-pointing.** `fileReimbursement` accepts up to 50 `bomItemIds` from
  any member and sets `reimbursementId` on each, including lines already tied to another
  reimbursement. Consider refusing lines that already have one.
- **12. Open client registration.** `/oauth/register` creates an `OAuthClient` row for
  any caller with an allow-listed redirect; nothing deletes them. Low impact (a row
  grants nothing), but a sweep of clients with no codes after a month would bound it.
- **13. Container runs as root.** The Dockerfile has no `USER`. Adding `USER node` after
  the global prisma install should work (nothing writes under `/app` at runtime) but was
  not tested here, so it is left for a deploy where it can be watched.
- `exchangeCode` does not require `redirect_uri` at the token step when the authorize
  step had one (RFC 6749 §4.1.3). PKCE makes it moot; noted for completeness.
- `set_featured` and `set_card_order` do a read and a shape check before the admin
  check, so a member learns a project id exists; the same data is on `list_projects`.
- `User.email` is unique case-sensitively while the admin and PVP lists compare
  lower-cased; two header spellings of one address would make two users.

## What checked out clean

- Tokens: `sp_` + 32 random bytes, stored as SHA-256, constant-time compare, scopes
  fixed at mint, revoke only your own, minting deliberately not an MCP tool.
- OAuth: PKCE S256 required; codes hashed, five-minute TTL, single use with replay
  revoking the issued token; redirect URIs allow-listed (claude.ai callbacks and
  loopback only) and re-checked at consent; the consent action re-validates the request
  from scratch; client names render through React (an `<img onerror>` name was inert).
- Caddy: `X-Auth-*` stripped before `forward_auth` on every site and on the public
  `/api/mcp*` and OAuth paths; `check_gate_order.py` passes; `/oauth/authorize` stays
  behind the cookie.
- Worker, internal and verify routes fail closed when their secret is unset
  (`checkWorkerToken`, `internalSecretOk`), constant-time compares throughout.
- Receipts: type decided by magic bytes, 4 MB cap, non-image/PDF served as attachment
  with `nosniff`; PII and receipt bytes only for the payee, the filer and admins
  (`canSeePii`), the same rule on the page, the route and the MCP tool; upload links
  are one-shot, keyed, fifteen minutes, usable only by their minter.
- Finance state machine: admins approve, only PVPs send/retry, owners cancel their own;
  optimistic `updateMany` guards against double decisions.
- Markdown through `react-markdown` (no raw HTML), links `rel="noreferrer noopener"`;
  email bodies escape user text; no `dangerouslySetInnerHTML` anywhere.
- Raw SQL: two `$queryRaw` tagged templates (parameterised), no `$executeRawUnsafe`.
- Points, project/subteam management, deletes, ops, outreach and the Finance tab are
  admin-gated in the actions and refuse over MCP; BOM approval/demotion and purchase
  decisions are PVP-gated.
- No secrets in the repo; `.env` ignored; CI runs lint, typecheck and tests on every
  change to `starproject/`.

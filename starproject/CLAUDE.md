# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

STARProject — internal team task tracker for STAR Berkeley (replacing OpenProject). Next.js 15 App Router + React 19 + TypeScript, PostgreSQL via Prisma, Tailwind 4. Lives inside the `STAR` monorepo (git root is the parent directory); commit messages are prefixed `starproject: ...`.

## Commands

```bash
npm run dev          # dev server on :3000 (needs DATABASE_URL + DEV_AUTH_EMAIL, see below)
npm run build        # prisma generate + next build (no DB needed)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint, --max-warnings=0 (warnings fail)
npm run test         # vitest run (all tests)
npx vitest run src/lib/tasks.test.ts   # single test file
npx prisma migrate dev                 # create/apply a migration locally
```

Dev environment (no Caddy locally, so identity comes from env):

```bash
export DATABASE_URL="postgresql://starproject:starproject@localhost:5432/starproject?schema=public"
export DEV_AUTH_EMAIL="you@berkeley.edu"
export DEV_AUTH_NAME="Your Name"
```

## Architecture

**Auth is upstream, not in-app.** In prod, Caddy's `forward_auth` gate injects `X-Auth-Email` / `X-Auth-User` headers; `src/lib/auth.ts:getCurrentUser()` is the single identity seam that reads them (dev falls back to `DEV_AUTH_EMAIL`/`DEV_AUTH_NAME`). There are no sessions, JWTs, or login pages in this codebase. `src/lib/user.ts:getCurrentDbUser()` upserts the viewer into the `User` table on every call — that's how users are provisioned and how the assignee picker gets populated.

**Flat permission model.** Any authenticated user sees and edits everything; Projects and Subteams are filtering lenses, not access control. Admin-only actions (project/subteam management) are gated by `src/lib/admins.ts`: a hardcoded seed list, plus runtime `AdminEmail` rows, minus `RemovedSeedAdmin` tombstones (seeds live in code, so removal needs a DB tombstone to stick).

**Mutations are server actions** in `src/lib/actions/*` (`"use server"`), validated with Zod schemas from `src/lib/validation.ts`, followed by `revalidatePath`. Every mutation appends to the `Activity` model via `recordActivity` (`src/lib/activity.ts`) — an append-only audit log that stores human-readable value strings *at the time of the change*, so history renders correctly even after entities are renamed or deleted. Don't skip activity recording when adding a mutation.

**Inline field edits** go through `src/lib/fieldUpdate.ts:updateField()`, which calls the `updateTask` action directly instead of via a `<form>` — a form action would trigger React 19's automatic post-submit form reset and snap controls back. Follow this pattern for new inline editors.

**Data model notes** (`prisma/schema.prisma`, well-commented — read it first):
- `Task.number` is a global human-facing `#N` from a Postgres sequence: never reused, never edited.
- `TaskBlocker` edges are display-only (blocked badge, Gantt arrows) — no cascade scheduling.
- Projects nest to any depth (`parentId`); `moveProblem` in `src/lib/project-tree.ts` refuses moves that would make a loop.
- `boardOrder` is a float for kanban ordering; `archived` hides done tasks from active views.

**MCP server** (`src/app/api/mcp/route.ts`, `src/mcp/`). Streamable HTTP, stateless, one `McpServer` per request. Identity is a personal access token (`ApiToken`, minted under Settings → API tokens or `scripts/mcp-token.mjs`) resolved by `src/lib/apiTokens.ts` and injected with `runAsIdentity` from `src/lib/auth.ts`, so tools call the *real* server actions and get the same audit trail as the UI. Tool modules live in `src/mcp/tools/*.ts`, are listed in `src/mcp/tools/index.ts`, and use `defineTool`/`toFormData` from `_shared.ts`. Every user-facing action in the app should have a tool; a new server action gets a tool in the same PR. `scripts/mcp-smoke.mjs` is a real client for checking it. Docs: `docs/MCP.md`.

**Email** (`src/lib/mail.ts`) sends via SES and no-ops when `SES_FROM` is unset, so dev/CI never send. Assignment emails are queued (`EmailQueueItem`) and flushed as one email per recipient by cron; `NotifLog` is the idempotency ledger so deadline emails never double-send. The cron endpoints under `src/app/api/cron/*` are POST routes hit by a sidecar container, gated by the `x-cron-secret` header (`CRON_SECRET`).

**Tests** are colocated `*.test.ts` files in `src/lib/` covering pure logic (board ordering, gantt, name formatting, task helpers) — vitest, node environment, no DB or React. Keep testable logic in `src/lib` as pure functions.

**Shared view types** live in `src/lib/board.ts`: `BoardTask` → `WorkspaceTask` → `TaskRowData` form a widening chain consumed by Board, Gantt, and the list table — extend these rather than inventing parallel shapes.

## Commits and PRs

Do not add Claude attribution anywhere: no `Claude-Session:` links, no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines in commit messages, PR titles/bodies, or code comments. Commits and PRs should read as authored solely by the user.

## Deployment

Self-contained standalone Docker image; `docker-entrypoint.sh` runs `prisma migrate deploy` on startup (the deploy box only pulls images), so every schema change must ship as a committed migration. Prisma `binaryTargets` includes `debian-openssl-3.0.x` for the container runtime — don't remove it. Compose services and the Caddy route live on the EC2 stack (`../deploy/ec2/docker-compose.yml`, `../deploy/ec2/caddy/Caddyfile`), not the root compose file. The `/api/mcp*` handle in that Caddyfile bypasses forward_auth; any new public sub-path must also be listed in `../deploy/caddy/tests/check_gate_order.py`.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cal STAR team members and leads tracking tasks and deadlines internally —
replacing OpenProject as the team's task tracker. Access is gated to current
team members (`@berkeley.edu`).

## Product Purpose

Internal team task tracker. Currently **Phase 0** — a walking skeleton that
proves auth, DB connectivity, migrations, and deploy end to end. Task-tracking
features themselves land in later phases; none exist yet.

## Positioning

Not yet differentiated from OpenProject on features (Phase 0 has none). The
stated reason for building this rather than keeping OpenProject is to run in
the same stack (Caddy auth, deploy, shared AWS credentials) as the rest of the
team's tools instead of as a separate system with its own login and hosting.

## Operating Context

Next.js (App Router, TypeScript) + PostgreSQL + Prisma, deployed as a
container behind Caddy's `forward_auth` at `project.starberkeley.org`.
Identity comes from Caddy-injected `X-Auth-Email` / `X-Auth-User` headers in
production, an env fallback (`DEV_AUTH_EMAIL` / `DEV_AUTH_NAME`) in dev.

## Capabilities and Constraints

Phase 0 scope only: the one page is `force-dynamic` and shows the caller's
dev identity plus a database-health check. No task-tracking UI exists yet.
Phase 5 (not yet built) adds SES email for assignment/deadline notifications,
reusing the stack's shared `AWS_*` credentials.

## Brand Commitments

Cal STAR internal-tools identity.

## Evidence on Hand

None — Phase 0 has no real content yet. Future design work must not invent
task data, boards, or workflows beyond what Phase 0 actually ships.

## Product Principles

- Prove the skeleton before designing the features — auth, DB, and deploy all
  had to work before any task UI was worth building.
- Live in the same stack as the rest of the team's tools rather than as an
  outside system to maintain separately.

## Accessibility & Inclusion

None established.

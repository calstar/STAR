# STARProject

Internal team task tracker (replacing OpenProject). **Next.js (App Router, TS) +
PostgreSQL + Prisma**, deployed as a container in the STAR apps stack behind
Caddy. Auth is handled by Caddy's `forward_auth` gate — the app just reads the
`X-Auth-Email` / `X-Auth-User` headers it injects (see `src/lib/auth.ts`).

This is **Phase 0** — a walking skeleton that proves auth, DB connectivity,
migrations, and deploy end to end. Features come in later phases.

## Local development

No Caddy runs in dev, so identity comes from an env fallback.

```bash
cd starproject
npm install

# a local Postgres (or point DATABASE_URL at any Postgres you have)
docker compose up -d starproject-db          # from the repo root, or run your own
export DATABASE_URL="postgresql://starproject:starproject@localhost:5432/starproject?schema=public"
export DEV_AUTH_EMAIL="you@berkeley.edu"      # stands in for the Caddy header
export DEV_AUTH_NAME="Your Name"

npx prisma migrate dev                        # create/apply the schema locally
npm run dev                                   # http://localhost:3000
```

The page should show your dev identity and a green **Database: Healthy**.

## Build / typecheck

```bash
npm run typecheck
npm run build            # runs `prisma generate` then `next build`
```

`next build` does **not** need a database — the only page is `force-dynamic`.

## Container

The image is self-contained (Next standalone output) and runs
`prisma migrate deploy` on startup via `docker-entrypoint.sh`, so a pull-only
deploy box applies migrations automatically.

```bash
# from the repo root
docker compose up --build starproject starproject-db
```

## Deploying a new subdomain (one-time, manual)

The app is served at **project.starberkeley.org**. Besides the Caddy route
(already in `deploy/caddy/Caddyfile`) and the compose services, add a Cloudflare
Zero Trust **published hostname** route: `project.starberkeley.org` →
`http://caddy:80`. Then on the apps box: `docker compose pull && docker compose
up -d`.

## Environment

| Var | Where | Purpose |
|-----|-------|---------|
| `DATABASE_URL` | app | Postgres connection string |
| `STARPROJECT_DB_USER` / `_PASSWORD` / `_NAME` | compose | Postgres credentials (set a real password in prod) |
| `DEV_AUTH_EMAIL` / `DEV_AUTH_NAME` | dev only | stand in for the Caddy-injected identity |

SES/email (assignment + deadline notifications) arrives in Phase 5 and will
reuse the stack's shared `AWS_*` credentials.

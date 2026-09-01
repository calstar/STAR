#!/bin/sh
# Apply any pending migrations before the server starts, then hand off to CMD.
# The apps box only pulls this image (no source, no npm), so migrations must run
# from inside the container. `migrate deploy` is idempotent — a no-op once the
# schema is current.
set -e

echo "[starproject] Applying database migrations (prisma migrate deploy)…"
prisma migrate deploy --schema=/app/prisma/schema.prisma

echo "[starproject] Migrations up to date. Starting Next.js server…"
exec "$@"

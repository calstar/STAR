# Deploying STAR Parts Hub: runbook for the setup agent

You are setting up **STAR Parts Hub** on STAR's apps machine. It is a new app in this repo (`parts-hub/`). This file gives you everything you need; work through it in order and check each box's result before moving on. For what the app does and how it works, see [README.md](README.md).

**This repo is public. Never commit a secret.** Secrets go only into the apps machine's root `.env` (`/opt/STAR/.env`). Ask the human you're working with (Carlos Bautista) for any value marked *from Carlos*, and paste it only into that file.

## Facts

| | |
|---|---|
| Public URL | `https://parts.starberkeley.org` (hub, behind the STAR login) |
| Onshape panel URL | `https://parts.starberkeley.org/panel/` (**not** behind the STAR login, on purpose; see below) |
| Container | `parts-hub` in the root `docker-compose.yml`, port 8080, image `ghcr.io/calstar/star-parts-hub` |
| Data | Docker volume `parts_data` → `/data` (SQLite + uploaded CAD files + thumbnails). **Must be backed up.** |
| Memory | 2 GB limit (drawing thumbnails of big STEP files) |
| Onshape | STAR Enterprise at `https://starberkeley.onshape.com` |
| Onshape OAuth app | "STAR Parts"-style app registered in Enterprise settings → Developer. Client ID `R7DVHSNH2EPZUDCFMJOOL6UTPQG7UEZAUA4KJMA=` (public, not secret) |
| OAuth redirect URL | `https://parts.starberkeley.org/panel/oauth/callback` (must match the app exactly) |

**Why `/panel/*` is public:** it's loaded inside Onshape's iframe, where the STAR session cookie is never sent, so the normal gate would always refuse it. Instead it authenticates members with Onshape OAuth, never reads `X-Auth-Email`, and only offers the read-only catalog and "insert". The Caddyfile strips identity headers on that path, and `deploy/caddy/tests/check_gate_order.py` allows exactly that prefix (`PUBLIC_PATHS`). Everything else on the host is gated like every other app.

## Status (2026-09-27)

Already done on the apps machine and in Onshape:

- `/opt/STAR/.env` has `PARTS_ONSHAPE_CLIENT_ID`, `PARTS_ONSHAPE_CLIENT_SECRET`, `PARTS_SESSION_SECRET` and `PARTS_LIBRARY_DOCUMENT_ID` (backup: `.env.bak-20260927-1648`). `docker compose config` validates.
- No separate key pair is needed: the stack's `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY` (Aidan's) has Write scope, and the hub falls back to it.
- The **STAR Parts Library** document exists: `https://starberkeley.onshape.com/documents/64c6e9b3f2e516c1dd98bdf9`.

Still to do: share the library document with the Enterprise (step 1), the Onshape extension and assignment (step 1), the Cloudflare hostname (step 3), and merging the PR (step 4).

## 0. Order matters: configure before merging

Merging to `main` makes CI publish the image, and `star-auto-update` deploys it. If the `PARTS_*` values aren't in `/opt/STAR/.env` yet, the container exits at startup with a list of what's missing. The rest of the stack is unaffected, but the auto-update tick is marked failed. So do steps 1–3 first, then merge (step 4).

## 1. Onshape side (a human with Enterprise admin does this)

Walk Carlos through these; you can't do them from the server.

- [x] **API key with Read + Write.** The hub imports parts and creates versions, so its key pair needs Write scope. The stack's `ONSHAPE_ACCESS_KEY` / `ONSHAPE_SECRET_KEY` has it, and the hub uses it unless `PARTS_ONSHAPE_ACCESS_KEY` / `PARTS_ONSHAPE_SECRET_KEY` are set. A read-only pair fails with `Invalid API key state`. If that pair is ever replaced, give the hub its own Read + Write pair (ideally from a team/bot account).
- [ ] **Library document.** *Created:* `64c6e9b3f2e516c1dd98bdf9`. Shared with "All enterprise users". It must be **Can view with Link** permission: view alone makes every insert fail. Keep edit access to admins and the key's owner. Its id is the 24-character value in the URL `https://starberkeley.onshape.com/documents/<id>/w/...` → `PARTS_LIBRARY_DOCUMENT_ID`. (Onshape adds an empty "Part Studio 1" and "Assembly 1"; they can stay, the hub ignores default-named tabs.)
- [ ] **OAuth app settings** (Enterprise settings → Developer → OAuth applications → the app):
  - Redirect URLs: `https://parts.starberkeley.org/panel/oauth/callback`
  - OAuth URL: `https://parts.starberkeley.org/panel/`
  - Permissions: **read your documents** + **write to your documents** only
  - The client secret → `PARTS_ONSHAPE_CLIENT_SECRET` (*from Carlos*; Onshape shows it only once)
- [ ] **Extension** (same app → Extensions → Add extension):
  - Name `STAR Parts`, Location **Element right panel**, Context **Inside assembly**
  - Action URL: `https://parts.starberkeley.org/panel/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}`
  - Icon: `parts-hub/public/panel/icon.svg`
- [ ] **Assign the app** (Enterprise settings → Developer) to Carlos only for now. Widen it to everyone after step 6 passes. Assignment is what makes the icon appear in assemblies; no App Store entry is needed.

## 2. Server `.env`

On the apps machine, edit `/opt/STAR/.env` (never the repo) and add:

```bash
# ── STAR Parts Hub ──
PARTS_ONSHAPE_CLIENT_ID=R7DVHSNH2EPZUDCFMJOOL6UTPQG7UEZAUA4KJMA=
PARTS_ONSHAPE_CLIENT_SECRET=<from Carlos>
PARTS_LIBRARY_DOCUMENT_ID=<24-char id from step 1>
PARTS_ONSHAPE_ACCESS_KEY=<Read+Write key from step 1, from Carlos>
PARTS_ONSHAPE_SECRET_KEY=<from Carlos>
PARTS_SESSION_SECRET=<generate below>
```

Generate the session secret on the box (it signs Onshape sign-in state and encrypts stored tokens; changing it later just signs everyone out of the panel):

```bash
openssl rand -base64 32 | tr -d '/+=' | head -c 43; echo
```

`PARTS_ONSHAPE_*_KEY` is optional only if the shared `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY` pair is replaced by one with Write scope. Keep `.env` mode 600.

## 3. Cloudflare

Zero Trust → Networks → Tunnels → the **apps machine's** tunnel → Add published application:

| Subdomain | Domain | Service URL |
|---|---|---|
| `parts` | `starberkeley.org` | `http://caddy:80` |

Same as the other app hostnames (deploy/apps/README.md §1). No Cloudflare Access policy on this hostname: STAR's own gate does the login, and `/panel/` has to be reachable from Onshape's iframe.

## 4. Deploy

Merge the `parts-hub` PR into `main`. CI (`publish-apps.yml`) publishes `ghcr.io/calstar/star-parts-hub`, and the auto-update timer rolls it out, including the Caddyfile change (Caddy runs with `--watch`). To deploy right away instead of waiting for the timer:

```bash
cd /opt/STAR
git pull
docker compose --profile tunnel pull parts-hub
docker compose --profile tunnel up -d parts-hub caddy
docker compose logs --tail=50 parts-hub
```

Expected log line: `STAR Parts Hub listening on :8080 (Onshape; data in /data)`. If you see `Configuration problems:` instead, it lists the missing variables; fix `.env` and `up -d parts-hub` again.

## 5. Verify

- [ ] `docker compose ps parts-hub` shows it running and **healthy** (the image has a `/healthz` healthcheck).
- [ ] Browser, signed in to STAR: `https://parts.starberkeley.org` shows the parts list and the signed-in email top right.
- [ ] Private window, not signed in: `https://parts.starberkeley.org` bounces to the STAR login, **and** `https://parts.starberkeley.org/panel/` responds (it redirects to Onshape sign-in, which is correct).
- [ ] Gate tests still pass (CI runs them on the PR too): `./deploy/caddy/tests/test_auth_gate.sh`.

## 6. Smoke test (real Onshape, end to end)

Needs any vendor STEP file and a **test assembly** the API key's owner can edit (workspace URL). It adds one Part Studio named `SMOKE TEST <time>` to the library document, inserts it into the test assembly, and prints the number of Onshape API calls used (about 7). It doesn't touch the hub database.

```bash
docker compose cp ./sample.step parts-hub:/data/sample.step
docker compose exec parts-hub node --disable-warning=ExperimentalWarning scripts/smoke-test.ts \
  /data/sample.step https://starberkeley.onshape.com/documents/<did>/w/<wid>/e/<eid>
```

On `PASS`, have Carlos delete the smoke-test Part Studio from the library document (or keep it via "Check Onshape for new parts" in the hub).

Then the real thing: Carlos opens any assembly in Onshape, clicks the **STAR Parts** icon on the right edge, authorizes once, searches, and clicks a part to insert it. When that works, widen the app assignment (step 1) to everyone.

## 7. Backups

`parts_data` is not a cache: it holds the only copy of the part metadata (names, costs, links, specs, history) and the uploaded CAD originals. Add it to whatever backs up the other volumes. A consistent snapshot while running:

```bash
docker compose exec parts-hub node --disable-warning=ExperimentalWarning scripts/backup.ts    # prints /data/backups/hub-<time>.sqlite
docker compose exec parts-hub tar czf - -C /data backups originals thumbs > parts-hub-$(date +%F).tgz
```

Restore: stop the container, put the snapshot back as `/data/hub.sqlite` (remove `hub.sqlite-wal`/`-shm`), restore `originals/` and `thumbs/`, start it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container restarts, logs say `Configuration problems:` | A `PARTS_*` value is missing from `/opt/STAR/.env`. |
| "Update Onshape" fails with `Invalid API key state` | The key pair is read-only. Needs a Read + Write pair (step 1). |
| Panel keeps bouncing to Onshape sign-in / "Sign-in link expired" | Redirect URL on the OAuth app doesn't exactly match `https://parts.starberkeley.org/panel/oauth/callback`, or the client secret is wrong. |
| Panel shows "Onshape refused the insert" | The member lacks **Link** permission on STAR Parts Library (view alone isn't enough: inserting from another document is linking; add Link to the Enterprise share) or edit access to their assembly. |
| No STAR Parts icon in assemblies | App not assigned to that member in Enterprise settings → Developer, or the extension's context isn't "Inside assembly". Reload the Onshape tab after assigning. |
| Hub returns 401 "Not signed in with a school account" | Reached without the Caddy gate, or the auth service isn't passing `X-Auth-Email`. Check the Caddyfile site block. |
| Picture missing for a part | STEP/IGES/STL are drawn on the server. Other formats and multi-file assemblies get Onshape's render at the next "Update Onshape". "Redraw picture" on the part page retries. |

Onshape API usage (the Enterprise has an annual allowance) shows at the top of the hub's parts list. Normal use is about 1 call per part added and 1 per insert.

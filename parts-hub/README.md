# STAR Parts Hub

A central CAD parts library for STAR, with a panel inside Onshape for dropping parts into assemblies.

- **Hub** (`https://parts.starberkeley.org/`, behind the STAR login). Members upload CAD files and keep every detail about a part here: name, part number, vendor, cost, links, specs and notes.
- **Onshape panel** (`/panel/`, a right-hand panel in Onshape Assemblies). A searchable grid showing each part's picture and name. Click a part to insert it into the open assembly.

```
           STAR login (Caddy)                        Onshape OAuth
 members ─────────────► Hub UI ──┐        ┌── Panel UI ◄────────── members in Onshape
                                 ▼        ▼
                           Node/Express backend ── SQLite + DATA_DIR (originals, thumbnails)
                                 │                        │
          service-account API keys│                        │ member's OAuth token
                                 ▼                        ▼
                "STAR Parts Library" document     POST .../assemblies/.../instances
                (one Part Studio per hub part)     (insert into the member's assembly)
```

- **Geometry** lives in one Onshape document, *STAR Parts Library*, owned by a service account. Each hub part maps to one Part Studio in it.
- **Metadata** lives in the hub database. The panel reads the catalog from the hub and never from Onshape tab names.

## Contents

1. [Try it locally (mock mode)](#try-it-locally-mock-mode)
2. [Onshape setup](#onshape-setup)
3. [STAR login](#star-login)
4. [Deploying (STAR stack)](#deploying-star-stack)
5. [Data and backups](#data-and-backups)
6. [Smoke test](#smoke-test)
7. [How it behaves](#how-it-behaves)
8. [Development](#development)

## Try it locally (mock mode)

Requires Node 24+. No Onshape credentials are needed: a fake Onshape client and 12 sample parts are used.

```bash
npm install
npm run mock
```

- Hub: http://localhost:8080/ (you are `dev@berkeley.edu`)
- Panel, as Onshape would open it (make the window narrow): http://localhost:8080/panel/?documentId=0123456789abcdef01234567&workspaceOrVersion=w&workspaceOrVersionId=0123456789abcdef01234568&elementId=0123456789abcdef01234569

In mock mode, uploads get real pictures (drawn from the file) and **Update Onshape** runs the real batch logic against a fake Onshape. A file whose name contains `fail` fails, so you can see the error and retry states. "Check Onshape for new parts" finds 3 Part Studios that only the fake Onshape knows about. Mock data is stored in `./data-mock/`; delete that folder to start over.

## Onshape setup

STAR is on an Onshape **Enterprise** (`starberkeley.onshape.com`), which makes this simpler than for a personal account. An enterprise admin registers the app under the Enterprise's developer settings and assigns it to the team. That assignment is what makes the **STAR Parts** icon appear in everyone's assemblies. No App Store entry and nothing for members to install.

Do all of this signed in with an **enterprise admin** account (your own is fine if you are one). Use the **Enterprise settings** pages, not **My account**: an app registered there belongs to the Enterprise, so other admins can manage it after you leave.

### 1. API keys (server side)

The hub talks to the library document with an API key pair that needs **Read and Write** scopes (it imports parts and creates versions). Set it as `PARTS_ONSHAPE_ACCESS_KEY` / `PARTS_ONSHAPE_SECRET_KEY` in the stack's root `.env`. Without those it falls back to the shared `ONSHAPE_ACCESS_KEY` / `ONSHAPE_SECRET_KEY`, which currently has Write scope. A read-only pair fails with "Invalid API key state".

The current pair belongs to a person's account. Uploads therefore show that person as the author of each import and version, and the integration stops working if that account loses access. When convenient, create a dedicated enterprise user (e.g. `star-bot@…`) with its own key pair (read + write scope) and swap it in.

### 2. Library document

1. Create a document in the Enterprise named **STAR Parts Library** and put its id in `PARTS_LIBRARY_DOCUMENT_ID`. The id is the 24-character value in `https://starberkeley.onshape.com/documents/<id>/w/...`.
2. Share it **Can view** with the whole Enterprise, or with the team that uses the panel, **with the Link permission turned on**: Onshape treats inserting from another document as linking to it. Without Link (view alone isn't enough), inserts fail with "Onshape refused the insert…".
3. Keep edit access to the key's owner and admins. The hub imports parts and creates versions in this document, and hand edits in the workspace end up in the next version.

Parts can also be imported straight into this document in Onshape (free), then picked up with **Check Onshape for new parts** in the hub.

### 3. OAuth app (for the panel)

**Enterprise settings → Developer → OAuth applications → Create new OAuth application:**

| Field | Value |
|---|---|
| Name | STAR Parts |
| Primary format | `org.starberkeley.parts` |
| Summary | STAR parts catalog: search and insert library parts |
| Redirect URLs | `https://parts.starberkeley.org/panel/oauth/callback` |
| OAuth URL | `https://parts.starberkeley.org/panel/` |
| Permissions | **Application can read your documents** and **Application can write to your documents** (an insert modifies the member's assembly) |

Copy the **client ID** and **client secret** into `PARTS_ONSHAPE_CLIENT_ID` and `PARTS_ONSHAPE_CLIENT_SECRET`. The secret is shown only once.

### 4. Extension (the icon in Assemblies)

On the app, open **Extensions → Add extension**:

| Field | Value |
|---|---|
| Name | STAR Parts |
| Location | **Element right panel** |
| Context | **Inside assembly** |
| Action URL | `https://parts.starberkeley.org/panel/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}` |
| Icon | `public/panel/icon.svg` from this repo |

Onshape documents `{$workspaceId}` as deprecated for right-panel extensions, so the URL uses `{$workspaceOrVersion}`/`{$workspaceOrVersionId}`. The panel only inserts in a workspace; in a version or history view it says so.

### 5. Assign the app to the team (makes the icon appear)

Onshape's docs: *"Company, Classroom, and Enterprise admins can assign internal users, aliases, and teams to apps in their Developer Settings without having to create a store entry."* In **Enterprise settings → Developer**, assign **STAR Parts** to everyone, or to a team or alias holding the members who should have it. Assigned members reload an assembly and see the icon on the right edge, next to the configuration and appearance icons.

The first time each member opens the panel, Onshape asks them to authorize STAR Parts once. After that it stays signed in; tokens are kept server-side and refreshed automatically.

Test before rolling out: assign it only to yourself first, then widen once the smoke test passes.

## STAR login

The hub has no login of its own. It sits behind the same gate as every other STAR app: Caddy's `(protected)` snippet calls auth's `/verify` and passes the signed-in user as `X-Auth-Email` / `X-Auth-User`, after stripping any copy the client sent. The hub reads those headers (`AUTH_EMAIL_HEADER`, `AUTH_NAME_HEADER`) and only accepts `@berkeley.edu` (`ALLOWED_EMAIL_DOMAINS`).

The one difference from the other apps: **`/panel/*` must not be gated**. The panel runs inside Onshape's iframe, where the STAR session cookie isn't sent (it would be a third-party cookie). It authenticates members with Onshape OAuth instead, and only offers the read-only catalog and insert. The Caddy block below strips the identity headers on those paths.

## Deploying (STAR stack)

The app is already wired into the STAR stack:

- the `parts-hub` service and `parts_data` volume in the root `docker-compose.yml`
- the `parts.starberkeley.org` site in `deploy/caddy/Caddyfile` (gated, except `/panel/*`; the gate tests in `deploy/caddy/tests/` know about that one prefix)
- the image in `.github/workflows/publish-apps.yml`, plus tests and an image build in `.github/workflows/parts-hub-ci.yml`
- the `PARTS_*` variables in the root `.env.example`, and a card on the landing page

**First-time setup** (Onshape app, server `.env`, Cloudflare hostname, smoke test) is a step-by-step runbook: **[DEPLOY.md](DEPLOY.md)**. After that, updates ship like every other app: merge to `main`, CI publishes the image, and the apps machine's auto-update rolls it out.

## Data and backups

Everything lives in `DATA_DIR`, which is `/data` in the container (the `parts_data` volume in the STAR stack):

| Path | What |
|---|---|
| `hub.sqlite` (+ `-wal`, `-shm`) | parts, edit history, panel sessions (Onshape tokens, encrypted with `SESSION_SECRET`) |
| `originals/<part id>/` | the uploaded CAD files, byte for byte |
| `thumbs/` | part pictures (can be regenerated with "Redraw picture") |
| `backups/` | database snapshots from `scripts/backup.ts` |

Don't copy the live `hub.sqlite` while the app runs. Take a snapshot first:

```bash
docker compose exec parts-hub node scripts/backup.ts   # prints /data/backups/hub-<time>.sqlite
docker compose exec parts-hub tar czf - -C /data backups originals thumbs > parts-hub-$(date +%F).tgz
```

Run that nightly from cron and copy the archive off the server. To restore, stop the container, put the snapshot back as `/data/hub.sqlite` (delete any `hub.sqlite-wal`/`-shm`), restore `originals/` and `thumbs/`, and start again.

The Onshape library document is its own source of truth for geometry and is versioned by Onshape. Nothing in it is ever deleted by the hub.

## Smoke test

Checks the whole path against real Onshape. It stages a STEP file like an upload (drawing its picture locally), runs **Update Onshape**, confirms the Part Studio is in the new library version, inserts it into a test assembly, and prints how many API calls that took:

```bash
docker compose exec parts-hub node scripts/smoke-test.ts /data/sample.step \
  https://starberkeley.onshape.com/documents/<did>/w/<wid>/e/<eid>
```

- Copy any vendor STEP to `data/sample.step` first.
- The assembly URL must be a **workspace** URL of an assembly that the **service account can edit** (the insert uses the service account's keys).
- The hub database isn't touched, but the new `SMOKE TEST <time>` Part Studio stays in the library document. Delete it in Onshape afterwards, or keep it with "Check Onshape for new parts".
- Locally: `node --env-file=.env scripts/smoke-test.ts ./sample.step <assembly url>`, or add `MOCK_ONSHAPE=1` to test the script itself.

## How it behaves

**Upload.** Uploading only touches this server: the file is stored and its picture is drawn right away from the CAD file (STEP, IGES, BREP and STL, rendered by OpenCascade compiled to WebAssembly plus a small software renderer). **No Onshape calls.** The part shows as "not in Onshape yet" and isn't in the panel. Several files can be uploaded at once.

**Update Onshape.** A button on the parts list sends every waiting part to Onshape in one batch, showing roughly how many API calls it will use:

1. Start one import per file into the library document (`flattenAssemblies=true`, so a multi-body vendor STEP becomes one Part Studio). The file is sent under the display name, so the tab gets that name without a rename call. Onshape also keeps the file as a tab next to it.
2. Check on all imports together (one call covers up to 20), at about 8 s, 19 s, 35 s, 58 s, then every 30 s.
3. Find the new Part Studio tabs (one call).
4. Name the parts inside them after the hub's display name (two calls for the whole batch: list the parts, rename them all). Vendor files often carry names like "Mirror 1", and the part name is what assemblies show. A single-part file gets the display name; with several parts, meaningful names are kept after it ("1/4 Union - NUT") and leftovers are numbered ("1/4 Union (2)").
5. Create **one** library version for the whole batch; that is what the panel inserts from.
6. Only for formats the server can't draw (SolidWorks, Parasolid, ...): ask Onshape for the picture (one call each).

A batch of N STEP files costs about **N + 7 calls**. A part Onshape can't translate fails on its own without holding up the rest. **Try again at next update** puts it back in line, and an update cut short resumes where it stopped instead of re-importing. All Onshape work goes through one queue, so two updates never race.

**Insert.** The panel inserts the **whole Part Studio at the part's version** (`isWholePartStudio: true`), so a fitting comes in as one unit, at the assembly origin. It inserts as the member (their OAuth token), so they need edit access to the assembly and view access to the library.

**Renaming** and every other edit are hub-only: no Onshape calls. The panel and hub always show the hub's name; the Onshape tab keeps the name the part had when it was added.

**Admins** (listed in [`config/admins.txt`](config/admins.txt), the same model as the DAQ server's `operators.txt`) get two extra buttons on a part's page. Everyone else can still upload, edit and archive.
- **Replace CAD file**: swaps in a new file and keeps the name, cost, links and specs. The picture is redrawn right away. The part is out of the Onshape panel until the next **Update Onshape**, which imports the new file as a fresh Part Studio. The old Part Studio stays in the library, so assemblies already using it are unchanged, and the hub never lists it again.
- **Delete part** (type DELETE to confirm): removes it from the hub for good: details, history, uploaded file and picture. Its Part Studio stays in the Onshape library (the hub never deletes Onshape data), and is never listed again.

To add an admin, add their email to `config/admins.txt` and merge. The running app re-reads the file when the apps machine auto-updates, with no restart.

**Archive** hides a part from the hub list and the panel. It never deletes anything in Onshape, and assemblies that already use the part are unaffected. Archived parts can be shown with "Show archived" and restored.

**Check Onshape for new parts** is the other way in: import STEP files straight into the library document in Onshape (Onshape's own website doesn't count against the API allowance), then press it in the hub. It finds Part Studios the hub doesn't know, creates one version for them, fetches their pictures from Onshape and lists them, named after their tabs, for you to fill in. Cost: about 5 calls plus 1 per new part. Empty default tabs ("Part Studio 1") are ignored. Server upload costs about the same (N + 7 per batch), so use whichever is convenient.

**Search** (hub and panel) matches every field: name, part number, vendor, category, tags, description, notes, cost note, custom fields and link labels. Every word must match, in any order. Words tolerate small typos (`vlave`), but sizes and part numbers never do: `5000 psi` won't find a 3000 psi part, and `SS-400-6` won't find SS-400-9 (punctuation is optional, so `ss4006` works). Fractions and decimals are interchangeable (`0.25` finds 1/4), inch marks and filler words are ignored, so `1/4 to 3/8 npt`, `3/8 npt 1/4` and `1/4" x 3/8" NPT` all find the same adapters. The panel still only shows picture + name. Hover a card for part number, vendor, cost and category, or click ⓘ for everything.

**Panel keys:** type to search. ↓/↑ move the highlight by row, and after that ←/→ move it by card. Enter inserts, Esc closes details or clears the search. The last 8 parts you inserted appear in a Recent row (stored in your browser).

## Development

```bash
npm run mock      # hub + panel with fake Onshape, auto-restart on changes
npm test          # API + search tests (mock Onshape)
npm run check     # TypeScript type-check
```

Node runs the TypeScript sources directly (type stripping), so there's no build step. Only erasable TypeScript syntax is allowed: no enums, namespaces or parameter properties. The frontend is plain JS modules with no bundler.

```
src/
  server.ts            startup: config check, DB, Onshape client, listen
  app.ts               routes: /panel/* (Onshape OAuth) and everything else (STAR login)
  config.ts            environment variables
  db.ts                SQLite schema + queries (node:sqlite)
  parts.ts             input validation, JSON shapes for hub and panel
  library.ts           Update Onshape batch, Check Onshape, pictures; the Onshape queue
  render/              local pictures: CAD file -> meshes (occt-import-js) -> PNG
  auth/hub.ts          trusts the proxy's identity header
  auth/panel.ts        Onshape OAuth, panel sessions, token refresh
  routes/hub.ts        hub API
  routes/panel.ts      panel API (catalog, insert)
  onshape/client.ts    Onshape REST calls (verified against the v17 API spec)
  onshape/mock.ts      fake Onshape for mock mode and tests
  seed.ts              sample parts for mock mode
public/
  hub/                 hub single-page app
  panel/               Onshape panel
  shared/search.js     fuzzy search used by both
scripts/
  smoke-test.ts        end-to-end check against real Onshape
  backup.ts            consistent DB snapshot
```

Out of scope, by design: mates or positioning, configured parts, multiple libraries, BOMs, inventory, purchasing, server-side favorites, roles/admin, App Store publishing, 3D viewers.

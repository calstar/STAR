# design-mcp — STAR's design-tools MCP server

Lets an agent (Claude Code, Claude Desktop, anything that speaks MCP) read the team's design apps
**as you**: saved designs in EngineDesign, pid-designer and star-openrocket; Layer X burns;
feed-twin run records; DAQ test-stand runs; and star-openrocket's simulations and exports. Every
app shows the agent exactly what it would show you, because each app still makes its own
permission decision.

- **Endpoint:** `https://mcp.starberkeley.org/mcp` (Streamable HTTP, stateless, JSON responses)
- **Auth:** `Authorization: Bearer sp_…`: a **STARProject** token with **Design tools** ticked
- **Runs on:** the apps box, next to the apps it reads (`docker-compose.yml`, service `design-mcp`)
- **Read-only:** no tool saves, shares or deletes anything in an app. Some compute (an export, a
  6-DOF flight) and cache the result; that is all.

STARProject's own MCP (tasks, finance) is a separate server on EC2: `starproject/docs/MCP.md`.
The two servers share one kind of token, minted and revoked in one place.

## Connecting

1. In STARProject: **Settings → API tokens**, tick **Design tools** (and STAR Project too if
   you want one token for both), **New token**, copy it.
2. Claude Code:

   ```bash
   claude mcp add --transport http star-design https://mcp.starberkeley.org/mcp \
     --header "Authorization: Bearer sp_…"
   ```

   Claude Desktop, through `mcp-remote`, the same way as `starproject/docs/MCP.md` shows.

A token without the Design tools scope gets `401` with `reason: "scope"`. If STARProject cannot
be reached to check a token, the answer is `503`: never a pass.

## How it is built

```
agent ──HTTPS──▶ Cloudflare ──▶ caddy (mcp.*: no cookie gate, X-Auth-* stripped)
                                   │
                                   ▼
                             design-mcp:8010 ──POST /api/mcp/verify──▶ STARProject (EC2)
                                   │   (token → email, cached 60 s)
                                   ▼  X-Auth-Email: <the token's owner>
            engine-design-api · pid-designer-api · star-openrocket-api · feed-twin-api · daq-viewer
```

- **Identity.** The server holds no tokens. For each one it has not seen in the last minute it
  asks STARProject (`POST /api/mcp/verify` with `DESIGN_MCP_VERIFY_SECRET`), which answers with
  the owner's email if the token is live and carries the `design` scope. A revoke reaches this
  server within that minute. The server then calls the apps on the compose network with
  `X-Auth-Email` set to that email, which is what Caddy's gate would have set for that person in a
  browser. This is safe only because **no app container publishes a port**: Caddy is the one way
  in, and it strips client-sent `X-Auth-*` (`deploy/caddy/tests/test_auth_gate.sh` checks the
  mcp host too).
- **Small results.** A tool result is read in full by the model, so nothing large goes into one.
  Long arrays are summarized (`data.compact`), series are downsampled with min/max buckets so
  peaks survive, and anything file-shaped comes back as a **link**.
- **Links.** `GET /files/<token>`: the token is HMAC-signed with `DESIGN_MCP_FILE_KEY`, names
  one file and the person it was issued to, and expires after 15 minutes. Anyone holding the link
  can download it until then, so an agent's sandbox can `curl` it with no header. Range requests
  work, so a large pull can resume. Every download is logged with who it was issued to.
- **Jobs.** Cloudflare gives up on an origin that has not answered in ~100 s. A slow call
  (indexing a DAQ run, a 6-DOF flight, an FEA export) runs as a job: the tool waits up to 25 s,
  then returns `{"job_id"}` for `job_status`. At most `DESIGN_MCP_JOB_CONCURRENCY` (2) run at once
  across everyone, so agents cannot starve the web UI on the same CPU. Jobs live in memory;
  a restart loses them and the tool is simply called again.
- **Tables.** A result with time series (a Layer X burn, a flight) becomes a *table*: parquet
  in the cache, with each signal's unit, under an id bound to the person who asked. The generic
  `table_*` tools question it without moving it.
- **Cache.** `/cache` (volume `design_mcp_cache`) holds blobs by content hash, with a 5 GB cap
  enforced oldest-first. Cached exports are keyed by *person* + source, so a cache hit is never a
  way around an app's own permission check. It is safe to wipe.

## Tools

| Tool | What it gives back |
|---|---|
| `whoami`, `list_apps` | the token's owner; which apps are reachable |
| `job_status`, `list_jobs` | a slow call's progress, then its result |
| `list_designs(app)` | designs you can open in `engine-design` / `pid-designer` / `openrocket` |
| `get_design`, `design_history`, `design_releases` | the design file (inline if small, link if not); microversions; releases |
| `download_design` | the design file as a JSON link (the same file pid-designer's Export saves) |
| `table_signals`, `table_series`, `table_plot`, `table_export` | question a table: signal list, a window of a few signals, a PNG, the whole thing as CSV/parquet |
| `layerx_list_runs`, `layerx_get_run` | your Layer X runs; one run without its per-step series |
| `layerx_run_table` | a finished burn as a table |
| `layerx_export(fmt)` | csv · parquet · fea (zip: pc, thrust, axial heat flux, peak loads) · eng (RASP thrust curve) |
| `engine_optimizer_results(layer)` | your latest Layer 1/2/3 results; the optimized config as a YAML link |
| `daq_list_runs`, `daq_run_summary`, `daq_run_config` | test-stand runs; size/duration; the config that ran |
| `daq_index_run`, `daq_components` | index a run once (a job), then list its channels |
| `daq_series`, `daq_plot` | a window of channels, downsampled by the viewer; or a PNG |
| `daq_export_csv` | a run (or a selection) as a CSV link (a job, capped to half the cache) |
| `openrocket_list_models`, `openrocket_model`, `openrocket_model_glb` | CAD models; manifest; mesh link |
| `openrocket_search_motors`, `openrocket_motor`, `openrocket_motor_file` | the motor catalog; one motor; its .eng/.rse |
| `openrocket_stability` | CP, CG, static margin |
| `openrocket_flight_dynamics` | 6-DOF ascent: apogee, max speed/Mach/accel/q, **max bending moment**, rail exit, min margin, drift + a table |
| `openrocket_recovery` | the descent, every failure case per chute, peak loads; axial/broadside bounds |
| `openrocket_export_ork` | the .ork as a link |
| `openrocket_recovery_devices` | the parachute catalog |
| `feedtwin_list_runs`, `feedtwin_get_run`, `feedtwin_diff_runs` | cockpit run records and what differs between two |

Units come from the apps: Layer X's CSV headers (`name [unit]`), and for the 6-DOF samples the
field comments on `FlightDynamicsResult` (`star-openrocket/backend/onshape/aero/rocketpy_flight.py`).

## Not here yet, on purpose

- **star-openrocket simulations from a design id.** The flight, `.ork` and recovery tools take
  the same request bodies the app's UI posts. Turning a saved design into those bodies (per-part
  masses from the manifest, overrides and hidden parts; the recovery slice through
  `toWireConfig`) happens in the browser today. A second copy here would drift from the UI and
  give different answers. Moving that conversion into star-openrocket's backend is the follow-up,
  and then these tools can take just a design id.
- **Exports that only exist in a browser.** pid-designer's PNG/SVG image export, EngineDesign's
  Layer 2/3 results CSV, and feed-twin's plot CSV are all built client-side. They need backend
  endpoints first. (A P&ID's JSON is `download_design`; Layer 2/3's config YAML is
  `engine_optimizer_results`.)
- **parts-hub** (Node, its own auth) and **writes** of any kind.
- **claude.ai connectors.** Those need OAuth rather than a header token; tokens cover Claude
  Code and Desktop.

## Running it

```bash
cd design-mcp
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q            # every tool end to end against fake apps
.venv/bin/python -m black --check star_design_mcp tests && .venv/bin/python -m pyflakes star_design_mcp tests

# A dev server: no token checks, every request is DESIGN_MCP_DEV_EMAIL.
DESIGN_MCP_PUBLIC_URL=http://127.0.0.1:8010 DESIGN_MCP_DEV_EMAIL=you@berkeley.edu \
DESIGN_MCP_FILE_KEY=$(openssl rand -hex 32) DESIGN_MCP_CACHE_DIR=/tmp/design-mcp \
PID_DESIGNER_URL=http://127.0.0.1:8001 ENGINE_DESIGN_URL=http://127.0.0.1:8000 \
  .venv/bin/python -m star_design_mcp
claude mcp add --transport http star-design-dev http://127.0.0.1:8010/mcp
```

An app whose URL is unset is simply absent (its tools say so). The server refuses to start with
neither a token check nor a dev email, or with both.

| Env | |
|---|---|
| `DESIGN_MCP_PUBLIC_URL` | where clients reach it; links are built on it, and its host is the only one accepted |
| `DESIGN_MCP_VERIFY_URL`, `DESIGN_MCP_VERIFY_SECRET` | STARProject's token check; the secret equals EC2's `DESIGN_MCP_VERIFY_SECRET` |
| `DESIGN_MCP_DEV_EMAIL` | dev only, instead of the two above |
| `DESIGN_MCP_FILE_KEY` | signs download links (≥ 32 chars; used for nothing else) |
| `DESIGN_MCP_CACHE_DIR`, `DESIGN_MCP_CACHE_MAX_BYTES` | the cache and its cap (5 GB) |
| `DESIGN_MCP_LINK_TTL_S`, `DESIGN_MCP_TOKEN_CACHE_S` | link lifetime (900), token-answer lifetime (60) |
| `DESIGN_MCP_JOB_CONCURRENCY`, `DESIGN_MCP_JOB_INLINE_WAIT_S` | jobs at once (2), wait before handing back a job id (25) |
| `ENGINE_DESIGN_URL`, `PID_DESIGNER_URL`, `OPENROCKET_URL`, `FEED_TWIN_URL`, `DAQ_VIEWER_URL` | each app's API on the compose network |

## Deploying (once)

1. Generate two secrets: `openssl rand -hex 32` twice.
2. EC2 `deploy/ec2/.env`: `DESIGN_MCP_VERIFY_SECRET=<first>`; recreate `starproject`.
3. Apps box `.env`: `DESIGN_MCP_VERIFY_SECRET=<first>`, `DESIGN_MCP_FILE_KEY=<second>`.
4. Cloudflare → the **apps box's** tunnel → add published application `mcp.starberkeley.org` →
   `http://caddy:80` (`deploy/apps/FRESH-INSTALL.md` §5).
5. `docker compose up -d design-mcp caddy` on the box. Check it with `list_apps` from a client.

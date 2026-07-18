# Playwright E2E (Sensor Info, Boards / Heartbeats, Load-time budget)

## One-time: system dependencies (Linux / WSL)

If Chromium fails to launch with missing `.so` libraries (e.g. `libnspr4.so`), install Playwright’s OS deps from the frontend directory:

```bash
cd diablo_server/frontend
sudo npx playwright install-deps chromium
```

That is the usual failure when the test exits before opening the page (not an assertion on Sensor Info). CI uses `npx playwright install --with-deps chromium`, which pulls these in automatically.

**`test/e2e_sensor_info.sh` with guitest:** if something already serves the GUI on `:3000` (normally the backend's static listener), the script **reuses** it and does not start a second server or kill your guitest pane on exit. (Its comments still mention `NEXT_PUBLIC_*` / "start Next" — pre-Vite fossils; those env vars are no-ops now.)

## URLs

Since the Vite migration the frontend derives API/WS URLs from `window.location` at runtime — there is **no env baking** and no `NEXT_PUBLIC_*`. The only knob Playwright reads is `PLAYWRIGHT_BASE_URL` (default `http://127.0.0.1:3000`, the backend's static GUI listener).

## Run locally

1. Start the full stack (e.g. `guitest`) — the backend serves the built GUI on :3000.
2. From repo root: `bash test/e2e_sensor_info.sh`, **or** `npm run test:e2e` in `diablo_server/frontend` against the running stack.

### One-shot: guitest + Playwright + stop (same as README `stopgui`)

From repo root:

```bash
bash test/e2e_guitest_playwright.sh
```

This starts the **guitest** stack (`USE_SIM=1`, detached tmux — no interactive attach), waits for :8081 and :3000, runs the Sensor Info Playwright spec, then runs `deploy/startup/stop_tmux.sh` (same role as README **`stopgui`**). Use `SKIP_STOP_GUI=1` to leave the stack running after tests.

## CI

- **Integration job:** `bash test/test_integration.sh` only (WebSocket / Elodin / stack checks). No browser tests.
- **Guitest E2E job:** `playwright-guitest-e2e` runs `bash test/e2e_guitest_playwright.sh` (full tmux guitest stack). That is browser E2E in CI.

## What the tests check

**`e2e/sensor-info.spec.ts`** — ingest header cards (packet count, **Ingest Rate**, board scan grid), and **columns 2–4** on every data row (raw ADC / counts, converted values, Frontend Rate Hz) with no `---` or empty text. Uses **`innerText` in the page**. Waits for PT/HPT loading rows to clear, then **`E2E_SETTLE_MS` (default 5000 ms)**, then one snapshot.

**`e2e/boards-heartbeats.spec.ts`** — **`/boards`** (“Boards / Heartbeats”): **every** card must have **State ACTIVE** (only that state passes), plus **CONNECTED**, **Heartbeat** numeric Hz (not **---**), and **Self Test: ALL PASSED**. Same settle delay as Sensor Info.

**`e2e/load-time.spec.ts`** — load-time budget guard (regression tripwire for the pre-Vite ~20s cold loads). Asserts `/` and `/sensor-info` are interactive (`<main>` visible) within **`E2E_LOAD_BUDGET_MS`** (default 10 s) and that Sensor Info shows first **live data** (Packets card loses its `---` placeholder) within **`E2E_DATA_BUDGET_MS`** (default 20 s). Budgets are generous because CI runners are slow; measured times (`[load-benchmark]` lines: interactive / DCL / load / FCP / first-data) are logged every run so trends are visible in CI history before the budget ever trips.

No long “wait until good” polling beyond the settle delay.

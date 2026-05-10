# Playwright E2E (Sensor Info, Boards / Heartbeats)

## One-time: system dependencies (Linux / WSL)

If Chromium fails to launch with missing `.so` libraries (e.g. `libnspr4.so`), install Playwright’s OS deps from the frontend directory:

```bash
cd diablo_server/frontend
sudo npx playwright install-deps chromium
```

That is the usual failure when the test exits before opening the page (not an assertion on Sensor Info). CI uses `npx playwright install --with-deps chromium`, which pulls these in automatically.

**`test/e2e_sensor_info.sh` with guitest:** if Next is already on `:3000`, the script **reuses** it and does not start a second dev server or kill your guitest pane on exit.

## Switchable URLs

| Preset | Thin backend (HTTP + WS) | Start Next with |
|--------|--------------------------|-----------------|
| **integration** (same ports as `test/test_integration.sh`) | `TEST_BACKEND_WS_PORT` (default **8181**) | `NEXT_PUBLIC_API_URL=http://127.0.0.1:8181` `NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8181` |
| **dev** (guitest-style) | **8081** | Leave `NEXT_PUBLIC_*` unset (browser uses hostname + 8081). |

`NEXT_PUBLIC_*` are applied when **Next.js starts**. `PLAYWRIGHT_BASE_URL` is read by Playwright only (default `http://127.0.0.1:3000`).

## Run locally

1. Start the full stack (backend must match the preset above).
2. From repo root: `bash test/e2e_sensor_info.sh` (starts Next on :3000, runs this suite), **or** start Next yourself then `npm run test:e2e` in `diablo_server/frontend`.

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

No long “wait until good” polling beyond the settle delay.

After any big change run an integration test this found here: test/test_integration.sh

**Playwright E2E (full stack + Sensor Info / Boards specs):** always run via

`bash /home/aidan/Diablo-FSW/test/e2e_guitest_playwright.sh`

(from repo root or with that absolute path). Do not run `npx playwright test` alone unless a stack is already up and you intend to hit only the browser tests.

The same script runs **`USE_SIM=1 bash scripts/build.sh`** before starting tmux; if you skip a full C++ build (e.g. run Playwright against an ad-hoc stack without that step), E2E can be **flakey**—run **`bash scripts/build.sh`** (with `USE_SIM=1` if matching sim) first when diagnosing odd failures.

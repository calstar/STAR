After any big change run an integration test this found here: test/test_integration.sh

**Playwright E2E (full stack + Sensor Info / Boards specs):** always run via

`bash daq-server/test/e2e_guitest_playwright.sh`

(from the STAR repo root, or `bash test/e2e_guitest_playwright.sh` from within `daq-server/`). Do not run `npx playwright test` alone unless a stack is already up and you intend to hit only the browser tests.

Both the E2E script and `test/test_integration.sh` run the canonical full build (`bash scripts/build.sh`) themselves, so stale-binary flakiness (historically: `fake_packet_generator` was omitted from a hand-maintained target list) is fixed — no manual pre-build needed. `USE_SIM` is a **runtime env var** consumed by the launch scripts / calibration_service, not a compile flag; sim and hardware use identical binaries.

# Testing notes for the remaster

Practical recipes for tests the remaster packages add. A recipe here is advice for writing a
test, not a design decision; the decisions are in `LEDGER.md` and the `DESIGN-WP*.md` notes.

## Backend vitests of `server/*` modules (WP6)

From DESIGN-WP6 (LEDGER D48, moved here by D49). Backend vitests live in
`diablo_server/backend/src/__tests__/`; paths below are spelled from there.

A vitest that imports a `server/*` module of layer 2 or above (DESIGN-WP6 §2) needs:

1. **`vi.mock('../server/ws-clients.js')`** whenever the code under test can reach a sender.
   After step 1, `wss` is an `export let` that `attachWebSocketServer` assigns (row 1.3), and
   `broadcast` dereferences it (`server.ts:905`, `wss.clients.size`), so any sender throws in a
   test process that never attached a server. (From a test inside `src/server/` the same mock is
   spelled `vi.mock('../ws-clients.js')`.)
2. **Fake timers:** `vi.useFakeTimers()` and `vi.setSystemTime(…)`. Module functions read
   `Date.now()` at today's sites and WP6 adds no clock seam; `elodin-reconnect.test.ts:62` and
   `board-scan-rate.test.ts:17, 23` already do this.
3. **Fresh module state per case:** `vi.resetModules()` and a dynamic `await import(…)` in each
   case. The modules are singletons; without a reset one case's state leaks into the next. Never
   destructure a live binding out of the imported namespace into a local that outlives the call
   (DESIGN-WP6 §8 R1).
4. **A `CONFIG_PATH` fixture** — a temp-dir `config.toml`, set before the first import, as
   `config-profile-create-calibration.test.ts:19` does — for any closure that reads config:
   one that contains `engine-state`, `commands`, `elodin-link` (it reaches `engine-state` through
   `onElodinConnected` → `refreshScriptStatus()`, `server.ts:1601`), `session-manager` (constructs
   `sessionManager` at import), `state-csv/state-actuators` (reads config at import, `:79-81`), or
   `config-caches` (G6 reads the boards). Never the checkout's `config/config.toml`.

A pure function over values (DESIGN-WP6's `mismatchVerdict`, if G1's fallback is recorded) needs
none of this.

Every such test lands with a mutation that turns it red (break the thing it guards, see it fail,
restore), recorded in the package's report. A backend vitest does not discharge a DESIGN-WP6 §7
characterization row; substituting one for a row is a decision the orchestrator records per row.

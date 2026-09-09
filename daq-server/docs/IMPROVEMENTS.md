# DAQ Server — Improvement Backlog

Known defects and improvement work across the C++ services, the TypeScript backend, the
frontend, and CI. Each item names the affected file(s), what actually goes wrong, and the
shape of the fix.

**Last audited:** 2026-09-08 against `1aeb97bc`.
**Last updated:** 2026-09-08 — the WebSocket backpressure work landed, resolving this file's
backpressure/keepalive entry under High: sensor data now stages in a per-client outbox that sheds
*resolution* rather than falling behind, squeezed to a measured-throughput latency budget, with the
30 s ping reaper and a `Throttled · N%` badge so no operator reads a decimated trace unknowingly. It
also capped encoders (their own budget, so the scope view's valve timing survives) and deleted the
dead `SUBSCRIBE_SENSOR` protocol. Before that, the config-gate work landed, which turned the config editor's
visual-only validation into a refusal at session start (and is recorded under Resolved, having been
raised directly rather than filed here). Before that, the controller PWM-mapping and FIRE-gate work landed, which
resolved both controller entries under High (correcting one's scope and the other's severity) and
turned up the two-writers finding now filed there. Before that, the Elodin subscription work landed (and withdrew this file's
claim that the heartbeat's 256-byte buffer was the problem); the DAQ-NIC pinning work landed, which merged and resolved the two
abort-broadcast entries and turned up the firmware finding now filed under Critical. The sequencer
concurrency and config draft-only work landed earlier the same day.

The revision before this one dated from April 2026 and predated the Vite frontend migration,
the `smol-toml` config work, and the config-driven `[[states]]` rework. Anything fixed is
recorded at the bottom with *how*, rather than silently dropped, so a future audit can tell
"resolved" from "never looked at".

---

## Critical

### Firmware — the server sends the abort packet nothing consumes, and withholds the one that is

**Files:** `firmware/Hotfire_Code/common/hotfire_config.h:33-34`,
`firmware/Hotfire_Code/Actuator_Hotfire/src/main.cpp:838,959,975-978`,
`firmware/Hotfire_Code/common/SensorHotfireCore.h:251-258`,
`diablo_server/services/sequencer/AbortBroadcaster.cpp:165`

**No board acts on `ABORT` (packet type 7).** Sensor boards do not decode it at all — their
handler covers only `CLEAR_ABORT` (9) and `NO_CONNECTION_ABORT` (11). The actuator board decodes
it, but the only transition consuming it is behind `if (ENABLE_ALL_STATE_TRANSITIONS)`, which is
`false` in `hotfire_config.h` with no override anywhere in `firmware/`. The same flag gates
heartbeat-loss detection at `:838`, the sole entry to `ConnectionLossDetected → NoConnectionAbort
→ PTAbort` — so the `[abort_pts]` overpressure trips are unreachable for the same reason, despite
being broadcast to the boards every second.

The mirror image: `CLEAR_ABORT` **is** consumed unconditionally (`main.cpp:959`,
`SensorHotfireCore.h:251`), and the server never sends it — `AbortBroadcaster::sendClearAbort()`
has zero callers repo-wide. Its own doc comment says "called when leaving abort states"; nothing
does.

So the whole board-side autonomous abort chain is compiled out, and the one packet the boards do
listen for is one the server does not produce. This is a firmware and rig-safety decision, not a
server fix: someone has to say whether `ENABLE_ALL_STATE_TRANSITIONS` was ever meant to ship
`true`, and what "leaving abort" should mean before `sendClearAbort()` is wired to anything.

**Worth being explicit:** this is why the abort routing work below was *not* the emergency the
previous revision of this file graded it. Getting the datagram onto the right wire is still
correct — it is a precondition for any of the above ever working — but it was fixing the delivery
of a packet with no consumer.

---

### C++ — Heartbeat maps sequencer states through a hardcoded enum table

> **Now reachable.** Until 2026-09-07 this was moot: `heartbeat_service` never received a
> `[0x50,0x00]` packet at all, so `stateToEngine()` never ran and `engine_state` was always 0.
> That is fixed (see Resolved), so the table below is live code for the first time.


**File:** `diablo_server/services/heartbeat/heartbeat_service_main.cpp:54-87`

`stateToEngine()` is a literal `switch` over the *compiled* `sequencer::State` numbering
(`case 16: return 3; // FIRE → FIRING`), and the heartbeat service is the only consumer of
sequencer state that never calls `StateMachine::loadStatesFromConfig()` — the sequencer,
the controller, and the TS backend all do.

Every other component was migrated off the compiled enum precisely because a rig that
renumbers `[[states]]` makes those ids name different states. The heartbeat still reads the
raw id off the wire and maps it through the old table. Its output is `engine_state` in
SERVER_HEARTBEAT, which the boards act on.

**Failure scenario:** a rig inserts a state, shifting ids. Config id 16 is now "Vent". Every
board is told `FIRING` while the rig vents; and when the rig actually fires (say config id
17), boards are told `SAFE`.

**Fix:** load `[[states]]` in the heartbeat process like the controller does
(`controller_main.cpp:216`) and drive the mapping off state *names* / declared flags
(`is_abort`, the `[fire] state` name) rather than numeric literals. The cleanest version is
a declared `engine_state` column in `[[states]]` so the mapping lives in config with the
states it maps.

---

## High

### CI — The static-analysis job cannot fail

**File:** `.github/workflows/daq-server-ci.yml:263-292`

```yaml
cppcheck --enable=all ... --error-exitcode=1 ... diablo_server/ archive/legacy/utl/ || true
```

The `|| true` cancels the `--error-exitcode=1` — the job reports green no matter what
cppcheck finds. The report is uploaded as an artifact nobody is required to read.

clang-tidy is weaker still: `|| true` **and** `continue-on-error: true`, and it runs on
`find ... | head -20` — the first twenty files in directory order, which does not include
the sequencer services where the races in this document live.

The rest of the workflow is genuinely strict (format-check, ctest, integration, Playwright),
which makes this job's decorative status easy to miss.

**Fix:** drop the `|| true` from cppcheck and let it gate, with an explicit suppression list
for whatever it currently flags (check the last uploaded artifact for the size of that job).
Run clang-tidy over the whole `diablo_server/services` and `diablo_server/lib/src` trees with
a checked-in `.clang-tidy` rather than an arbitrary 20-file slice.

---

### CI — No ASan/UBSan build, and CMake sets no warning flags

**Files:** `CMakeLists.txt`, `.github/workflows/daq-server-ci.yml`

*Partly addressed.* A `thread-sanitizer` job now builds the sequencer concurrency tests with
`-fsanitize=thread` and runs them, which is what proves the command-queue work stays fixed —
the races it guards are invisible to the Release `ctest` job, to cppcheck and to clang-tidy.

Two things still missing:

1. The top-level `CMakeLists.txt` still sets no `-Wall`/`-Wextra`. Implicit conversions,
   signed/unsigned mismatches and unused variables pass silently.
2. No ASan/UBSan build anywhere. A concrete UBSan-visible instance today:
   `config_broadcast_service_main.cpp:351,360,363` do
   `*reinterpret_cast<uint32_t*>(&buf[off])` into a `std::vector<uint8_t>` at offsets that step
   by 7 and 9 — unaligned stores through a `uint32_t*`. It works on x86-64 and ARM64 and is
   still undefined behaviour; `memcpy` compiles to the same instruction with none of the risk.

**Fix:** `add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter)` with
`-Werror=return-type` at minimum, and a `-DSANITIZE=ON` option wiring
`-fsanitize=address,undefined` run over ctest — mirroring how the TSan job is already wired.

**Note for whoever adds it:** the TSan job documents two traps that apply to any sanitizer job
here — `setarch -R` is required or the sanitizer aborts at startup on modern kernels with
`unexpected memory mapping`, and a sanitizer CHECK abort is *not* a `WARNING:` line, so gate on
the process exit code rather than grepping the log.

---

## Medium

### Backend — WebSocket commands are still parsed as `any`

**File:** `diablo_server/backend/src/server.ts:891` (`handleMessage(ws, message: any)`)

Real gates have been added since this was first written — `CONTROL_COMMAND_TYPES` requires
an armed operator connection (`server.ts:934`), and `state_transition` now rejects ids the
active config doesn't declare (`server.ts:942-969`). Those close the two exploitable holes.

What remains is shape validation. `handleMessage` still takes `any`, and the command
handlers still reach through non-null assertions: `command.data.state!`,
`command.data.actuatorName!`. A malformed message reaches business logic before anything
notices, and `sendToActuatorService(\`ACTUATOR:${undefined}:1\`)` is a wire message the
sequencer will parse and reject rather than an error the operator sees.

**Fix:** a discriminated union over `MessageType` validated at the `JSON.parse` boundary in
the `ws.on('message')` handler. `zod` is not currently a backend dependency and a hand-rolled
validator is about thirty lines — either is fine; validating before dispatch is the point.

---

### Frontend — No error boundaries anywhere in the app

**Files:** `diablo_server/frontend/src/App.tsx`, `diablo_server/frontend/src/main.tsx`

The app moved from Next.js to Vite + React Router since this item was written, but the gap
is unchanged: `main.tsx` renders `<BrowserRouter><App /></BrowserRouter>` with no boundary
at any level. Any component that throws during render — a missing config field, a sensor
value of an unexpected shape — blanks the entire dashboard.

**Fix:** an `ErrorBoundary` around `<App />` in `main.tsx` showing a message and a reload
button, plus finer-grained boundaries around the plots panel, the actuator grid, and the
state machine diagram so one section failing doesn't take the others with it. React Router's
per-route `errorElement` covers the routing case but not render throws inside a route.

---

### Frontend — Still no logger wrapper

**Files:** `lib/websocket.ts`, `lib/store.ts`, `lib/data-cache.ts`,
`components/dashboard/UnifiedDashboard.tsx`, `components/dashboard/IpadDashboard.tsx`,
`components/dashboard/GlobalStateSubscriber.tsx`,
`components/controls/StateMachineDiagram.tsx`, `components/windows/WindowManager.tsx`

Down from the original count but not gone — roughly ten `console.log` sites remain in
library code, on paths that fire per WebSocket message and per state change. No logger
wrapper exists in `lib/`.

**Fix:** a `lib/logger.ts` with `debug` gated on `import.meta.env.DEV` (Vite, not
`process.env.NODE_ENV` — the app is no longer Next.js), and replace `console.log` in library
code with it. Keep `console.error`.

---

### Backend — The resolved config path is never logged

**File:** `diablo_server/backend/src/routes/config.ts:19-81` (`getConfigPath`)

The loader tries three candidate paths in a `try`/`continue` loop and returns the first that
reads. Nothing is logged on success and nothing is logged for the attempts that failed. The
self-heal path below it *does* log (`🌱 Generated config.toml from …`), which makes the
silence on the normal path more confusing, not less: a box loading config from an unexpected
working directory looks identical in the logs to one loading the right file.

**Fix:** `console.info('[config] resolved: ' + path)` on success, and log each failed
candidate. Cheap, and it turns "the sensors are all wrong" into a one-line diagnosis.

---

### C++ — `config_broadcast` silently truncates at 255 entries

**File:** `diablo_server/services/config_broadcast/config_broadcast_service_main.cpp:336-337`

```cpp
size_t N = std::min(abort_actuators.size(), size_t(255));
size_t X = std::min(abort_pt_list.size(), size_t(255));
```

The wire format has a one-byte count, so the clamp is correct — but a rig that exceeds it
gets actuators or abort PTs silently dropped from the config the boards receive. An abort PT
that falls off the end is an overpressure gate that never arms.

**Fix:** log an error naming the dropped entries when either list exceeds 255. Given the
consequence, refusing to broadcast a truncated ACTUATOR_CONFIG is defensible too.

---

### Tests — `test_imu_calibration` is never built

**Files:** `diablo_server/lib/CMakeLists.txt`,
`diablo_server/lib/test/test_imu_calibration.cpp`

`test_imu_calibration.cpp` has no `add_executable` at all — it is not compiled, so it can
silently rot out of sync with the code it tests. (`test_robust_ddp`, which had the related
problem of being built but never registered with CTest, is now registered and passing.)

**Fix:** either wire it up or delete it. A test file that isn't built is worse than no test
file, because it reads like coverage.

---

## Low / Housekeeping

### Sensor Info — dual ADC columns (cal + raw) for debugging

**File:** `diablo_server/frontend/app/sensor-info/page.tsx`

Still open, and the groundwork is in place: `rawEntity` is already carried on the sensor
descriptor (`page.tsx:33`, populated at `page.tsx:451-454`) but nothing renders it. Every row
component reads ADC off the calibrated entity only (`page.tsx:136,169,202,229,257,283`).

Showing both side by side lets engineers confirm the raw vtable is arriving, spot
firmware-side ADC glitches independently of calibration, and verify the two agree (they
should be identical integers).

**Implementation sketch:**
- Add `useSensorValue(sensor.rawEntity, 'raw_adc_counts')` alongside the existing cal call in
  each row component (`PtRow`, `HptRow`, `TcRow`, `RtdRow`, `LcRow`, `ActRow`).
- Add a "Raw ADC" column beside "ADC (cal)" in each `SensorTable`.
- Render `---` when the raw stream is stale — its absence is expected, not a bug.
- Put it behind a "debug" toggle in the page header so the default table stays narrow.

---

### C++ — `ElodinClient::send_msg` logs on every send

**File:** `diablo_server/lib/src/elodin/ElodinClient.cpp:275`

`std::cout << "[ElodinClient] ✅ Sent registration message #" << send_count …` runs on every
`send_msg`, not only on registration, with a function-local `static size_t` counter that is
itself unsynchronized across the callers that share a client.

**Fix:** drop it to a debug level, or keep it only on the registration path it claims to
describe.

---

### Integration test — cleanup still uses a fixed 1 s grace period

**File:** `test/test_integration.sh:116-140`

Much improved since the last revision: ports are env-overridable, there's a pre-run port
sweep, and cleanup does SIGTERM → SIGKILL → `wait` plus a stale-process sweep. What remains
is the fixed `sleep 1` between the two signals — on a loaded CI runner a service can need
longer to flush, and on a fast machine it's a second wasted on every run.

**Fix:** poll `kill -0` in a short loop up to ~5 s instead of sleeping a flat second.

---

## Resolved

Kept so a future audit can distinguish "fixed" from "never checked".

### By the WebSocket backpressure work (2026-09-08)

- **Backend — WebSocket broadcast has no backpressure and no keepalive.** `broadcast()` handed
  every message to `ws.send()` and never read `ws.bufferedAmount`, so a client that stopped
  draining had every subsequent frame queued in the backend's heap without limit — ~47 live
  streams at 20 pts/s is ~124 KB/s per stalled client, ~460 MB/hour, and the backend is the one
  process feeding every dashboard. The team had hit this; the standing workaround was to restart
  the backend.

  The memory was the lesser half. A FIFO queue guarantees *completeness* and therefore gives up
  *currency* without bound: the tablet renders a smooth, plausible, coherent plot that is minutes
  old, with no gap, no stale badge, and `readyState` still `OPEN`. On a test stand that is worse
  than a blank screen. Measured against a 50 KB/s link, the old path never recovers — lag grows
  linearly (60 s at t=60, 96 s at t=120, 203 s at t=300) because drain rate is permanently below
  production rate.

  Sensor samples now stage in a per-client outbox (`backend/src/client-outbox.ts`) as min/max
  windows in a tiered ladder: a level that overflows merges its two *oldest* windows into one
  promoted a level up, so a window only ever merges with a same-resolution neighbour and old data
  cannot collapse. Merging keeps each extreme **with its original timestamp**, so a 620 psi
  ignition spike survives any number of compactions at its true time — verified in tests, and the
  reason this is min/max decimation rather than last-value conflation.

  Before each flush the ladder is squeezed to a latency budget derived from the client's *measured*
  drain rate (bytes handed to the socket ÷ time the socket took to empty), so what does not fit is
  compacted away rather than delayed. That inverts the control law from *fixed buffer, variable
  lag* to *fixed lag, variable resolution*: simulated at a 1.5 s budget, lag holds at ≤1.6 s across
  2000 → 20 KB/s while resolution degrades 100% → 16%. A healthy client is untouched — its outbox
  holds one window and the compaction path never executes.

  Two things had to be right for it to be safe. The flush fires only when the socket has actually
  **drained**, not merely dropped below a low-water mark — simulated with a 32 KB mark the socket
  queue climbed 42 → 93 → 152 KB, reintroducing the same unbounded queue one layer down. And only
  `SENSOR_UPDATE` passes through the outbox: control and event messages (`NOTIFICATION`,
  `STATE_UPDATE`, `SESSION_UPDATE`, `ACTUATOR_UPDATE`, …) still go out directly, because sensor
  samples are idempotent and the next supersedes the last, while a state transition or an abort
  notification is not.

  Also fixed alongside: the 30 s `ping`/`pong` reaper, so a socket whose peer vanished without a
  FIN is terminated instead of living in `wss.clients` forever; `SENSOR_DATA_STALE_MS` now measures
  age on the **server** timeline, so a throttled client reading current-but-coarse data does not
  blink "Data Pipeline Down" between batches; and the badge gained a `Throttled · N%` state
  (`frontend/lib/connection-badge.ts`, extracted from the nested ternary that was duplicated
  verbatim in `TopBar` and `MobileDashboard`) so no operator reads a decimated trace without being
  told — ranked below `Disconnected`/`Data Pipeline Down` so it can never mask an outage, and
  orange because yellow already means the pipeline is down. Every value on it is computed in the
  backend: `resolutionPct` needs a produced-count the browser never receives and `lagMs` needs the
  server clock. `/api/debug` reports `wsBufferedBytes`, `outboxWindowsHeld` and `heapUsedMb`, so
  "the dashboards are stuck" is now one curl rather than a restart.

- **Encoders were exempt from every rate cap.** `shouldThrottleSensorStreamPacket` covered
  `[0x20]`–`[0x23]` and `[0x30]`–`[0x31]`; encoder `[0x24]` fell through and emitted every packet
  uncapped. Folding it into the 20 pts/s GUI budget would have been wrong — `OscopeTriggerPlot`
  measures valve actuation timing from those samples (inter-encoder skew, plateau detection) and
  100 ms windows would quantize the measurement away — so encoders get their own
  `[gui] encoder_points_per_second` (default 100). At the boards' ~48 Hz that is one sample per
  window, `min == max`, and points pass through unchanged: a ceiling against a faster board being
  fitted, not a downsample of the current one.

- **`SUBSCRIBE_SENSOR` / `UNSUBSCRIBE_SENSOR` were dead protocol.** Two senders
  (`websocket.ts subscribeToAllSensors()`, `controller/page.tsx`), zero consumers — the backend
  fell through to `break`. Honoring them would have changed nothing either: the client asked for
  every channel at connect and never revised it. Deleted rather than implemented; there is no case
  where a dashboard wants a subset, and a slow link is now handled by shedding resolution instead.

### By the config-gate work (2026-09-08)

Not filed here — raised directly: the config editor's validation was **visual only**. It found real
problems (board slot clashes, duplicate state ids, a fire timer expiring into a refused transition,
an unassigned PWM output) and drew each one in red next to the field it concerned, and an operator
could read it, navigate away, and start a run on exactly that config. Three of the rules blocked the
editor's own Save button; none of them blocked **session start**, which is the one point where the
active profile is copied into `config/config.toml` and the C++ services read it. Config that arrived
by import, CSV upload or a hand-edited profile never passed the editor's guard at all.

| Item | Resolution |
|---|---|
| Rules lived in the editor as JSX, so nothing else could evaluate them | **Fixed.** `shared/config-validation.ts` holds them as pure functions (config + the three state CSVs in, `ConfigIssue[]` out). Both the editor and the backend import it, and the editor's local copies of `parseCsvGrid` / `diffKeys` / `boardSlotIssue` / `boardDisplayName` are deleted — one copy of each rule, not two. |
| Config errors did not stop a run | **Fixed.** `SessionManager.start()` validates the profile it is about to deploy and refuses. This is the enforcement point and the only one; a browser cannot skip it by not asking. Covered by `backend/src/__tests__/session-config-gate.test.ts` (hermetic: temp `CONFIG_PATH`, stubbed pipeline launcher), which fails 4/6 against the pre-gate code. |
| A refusal must not half-start a run | **Fixed.** The gate runs before any field of `SessionManager` is assigned, so a refused start leaves `active`, `dbDir` and `deadlineMs` untouched and `config.toml` unchanged. The pre-existing failed-deploy path mutated them first and left a `dbDir` for a run that never began; it is now behind the same guard. |
| Operators had no way to see the whole picture | **Fixed.** The refusal answers `SESSION_START_BLOCKED` with the issue list, and the session page renders it grouped by the config page that fixes each item, with a link to `/config?tab=<id>`. Pressing Start again sends `force` and runs anyway — the same decision, made deliberately. |
| Rules and editor tabs could drift | **Fixed.** `CONFIG_PAGE_LABELS` in the shared module is now what builds the editor's tab bar, so an issue's `page` is by construction a tab that exists. |

Two deliberate non-changes. **Warnings block too**, on the first press only: an operator who wanted
a warning would not have configured it that way, and one press to look is cheap — but a gate that
only fires on errors would leave "no state is flagged Abort" exactly as advisory as before.
**Simulated runs are not gated**, for the same reason they skip the deploy: they read the committed
`config_base → sim_config` overlay and never touch the profile, so gating them would block on config
that is not in effect, which is precisely how operators learn to press Start twice by reflex.

Turned up on the way, not fixed: the integration harness's own `[boards.integration_startup]` uses
`board_id = 60`, which maps to Elodin slot 10 — outside the 1-8 a packet id can encode. The board
works for what the test uses it for (startup self-test), and the editor would already have flagged
it; `GET /api/config/validate` is just the first thing to say so out loud. Filed nowhere yet
because it is test-harness config, not shipped config.

### By the controller PWM-mapping and FIRE-gate work (2026-09-08)

Filed as two entries — *"the controller falls back to hardcoded actuator channels when role names
don't match"* and *"the FIRE gate is a single-threaded accept loop with no receive timeout"*. The
first understated the scope; the second overstated the severity. Both are recorded here as found,
not as filed.

| Item | Resolution |
|---|---|
| Controller substituted `CH3`/`CH8` on board 12 for a missing role | **Fixed, and there were five fallbacks, not one.** Also removed: `PWMConfig`'s own member defaults (`192.168.2.201`, CH3, CH8) which gave the others something to land on; a synthesized boards 11-14 table when config declared none; `"192.168.2." + board_id` for a board with no declared IP; and two roles on two boards silently sharing the first one's IP. Every one was this process asserting a rig layout only config knows. |
| The role names were C++ string literals while the editor can rename roles | **Fixed.** The assignment lives on the `[actuator_roles]` entry, so a rename carries it along and cannot orphan it. Resolution moved to `lib/include/control/PWMTargets.hpp` so it is testable without a service; the controller refuses via the `setFireStateId(255)` pattern already in that file, naming which output has no actuator and why. In the editor the assignment is a per-actuator dropdown on the Actuators tab — you assign it where you define the actuator — and the Controller tab shows the resulting mapping. |
| Two roles on two boards was a warning and a wrong destination | **Supported, not refused.** `PWMConfig` carries an IP + channel per target; `sendActuationPWM` keeps the single batched datagram when both share a board and splits into two when they do not. That was never a policy question — the struct simply could not represent what config said. |
| Nothing tested the mapping | **Fixed.** `test_controller_pwm_roles` (ctest) covers 9 cases / 26 assertions, all pure resolution, including that polarity and assignment stay independent. `validateControllerPwmActuators` in `shared/types.ts` gives the config editor and the API one rule (11 vitest cases), and the editor blocks the save on it — the same posture as the existing duplicate-role and state-machine guards. `test_fire_lifecycle` section 6 now uses a normally-open assigned actuator, so it would catch a regression that re-merged polarity and assignment. |
| The accept loop wedged on a peer that sent no newline | **Fixed.** `SO_RCVTIMEO` on the accepted socket plus a thread per client, mirroring `sequencer_main.cpp` (64-client cap, `ERR:too many connections`, threads joined). `g_running` is now checked inside the read, so SIGTERM stops the process instead of needing SIGKILL. |
| "The PWM gate stays open until the process is killed" | **Withdrawn.** The controller's Elodin parity path (`ControllerService.cpp:782`) drives the same gate from the sequencer's published state, on its own thread, and closes it at burn end — as does the sequencer's own 1 Hz actuator republish. A wedge degrades the primary path; it does not strand the gate. |
| The real defect: the wedge was silent at both ends | **Fixed.** `notifyControllerFire` discarded the send result (`(void)n`) and logged `→ controller: FIRE_STOP` unconditionally — but a successful `send()` proves nothing, because the kernel completes the handshake and buffers for an application that may never read. It now reads the `OK\n` the controller already sends, retries once on failure, and logs an operator-facing error naming the endpoint. |
| The parity fallback never reconnected | **Fixed.** `elodinSubscriberLoop()` exited the moment `is_connected()` went false and was never restarted, so one db blip left the controller deaf to sequencer state for the life of the process. It now reconnects and *re-subscribes* (the VTables live in the db process), matching `heartbeat_service_main.cpp:103-120`, and the thread starts whenever a db is configured rather than only when the first connect happened to succeed. |
| Nothing tested any of it end to end | **Fixed, and it has teeth.** `ws_data_flow_test.ts` now holds a silent connection open on the controller's command port across the whole burn and asserts both commands still land *and* that the sequencer got an ACK for each; `test_integration.sh` starts a controller with a dangling actuator and asserts it refuses **and emits zero PWM datagrams** — "it logged a warning" being a much weaker claim than "it sent nothing". Verified against the pre-fix binary: 5 assertions fail and the run exits 1. |
| Dropped from the plan | A 1 Hz republish of sequencer state and a packet-rate watchdog on `fire_active_`: a clumsy instrument on a 6 s burn, and redundant once the ACK detects failure. Repeating FIRE_STOP was considered and rejected — the ACK tells you whether it landed instead of assuming volume fixes it. |

| The fire-state PWM handoff never engaged on a real rig | **Fixed, and it was the actual defect here.** `ActuatorCommander` skips controller-owned actuators during a burn so there is one writer — the mechanism was wired and `test_fire_lifecycle` section 6 tested it, but it keyed on `kind == "PWM"`, and `kind` is also where NC/NO polarity lives. No shipped config could mark anything `"PWM"` without losing its polarity, so nothing ever was, and the skip never fired. Found by the user; first filed by this work as "two writers on one channel", which named the symptom and the wrong cause. |
| Two independent declarations of which actuators the controller owns | **Collapsed into one.** This change first added `[controller].pwm_fuel_actuator` / `pwm_ox_actuator` beside the existing `kind = "PWM"` — the same duplication it set out to remove. Both are gone. An `[actuator_roles]` entry's optional 4th element (`"pwm_fuel"` / `"pwm_ox"`) is now the single statement: the controller resolves its targets from it and the sequencer's handoff reads the same field, so they cannot disagree. `kind` means polarity and nothing else, so `"LOX Press" = ["NO", 8, 12, "pwm_ox"]` is expressible — it was not before. |
| Duplicate assignment was not expressible, let alone caught | **Now an error.** Two actuators claiming one output is reported by name rather than silently resolved to the first; `validateControllerPwmActuators` blocks the save and the controller refuses the gate. Both outputs unassigned stays valid — that is a rig which does not use the PWM controller (digital-twin), and the editor must not make it unsaveable. |

**Corrected in passing:** `SequencerService.cpp:321` claimed the controller endpoint
"defaults to 127.0.0.1:8000"; it is `9999`.

### By the Elodin subscription work (2026-09-07)

Filed as *"`read_packet` desynchronizes the Elodin stream on an oversized packet, and the heartbeat
buffer guarantees it"*. The named function was right and the reason was wrong, which is what
happens when an entry is written from reading code rather than running it.

| Item | Resolution |
|---|---|
| `heartbeat_service` broadcast `engine_state = 0` forever | **Fixed — and this, not the buffer, was the live defect.** It reads one table, `[0x50,0x00]`, and subscribed with `subscribe_stream()`, which never included it. Measured with the real binaries against a real elodin-db: four sequencer transitions, 101 heartbeats, every one carrying 0; 0% CPU with the Elodin thread parked in `recv()`, no error logged. After: `{0, 1}` tracking the sequencer. |
| `subscribe_stream()` promised "all stream data" and delivered calibration's list | **Deleted.** It sent 480 raw sensor ids (a hardcoded boards 1-8 × channels 1-10 guess) plus the calibration command table — 481 messages on every call, and calibration re-called it every 5 s of silence. Replaced by `raw_sensor_tables()` / `calibrated_sensor_tables()` in `DatabaseConfig.hpp`, built from the boards actually in config, so every consumer now names what it reads. `ControllerService` already did this and was left alone. |
| The buffer claim itself | **Withdrawn.** Nothing overflows 256 today: the largest packet observable anywhere is 179 bytes (a VTable definition); ACKs are 19-23 and state updates 25. The "large subscription-ACK burst" the calibration comment blames is 481 *small* packets, and `read_packet` handles one packet per call — the aggregate never touches the bound. calibration's 64 KB was avoidance, not a fix. |
| `read_packet` abandoned the payload on an oversized packet | **Fixed** — drains and skips, returning 0, which every caller already handles. The desync was real, just not firing: reproduced against a live db with a 160-byte buffer against 179-byte packets, after which every read returned garbage lengths (`1638688`, `134742016`, …) indefinitely while `is_connected()` stayed true. |
| `read_packet` wrote 4 bytes past the caller's buffer | **Fixed.** The bound was `packet_len > max_len` but the function writes `packet_len + 4`. Proven with a guard page: `EFAULT` at exactly `packet_len == max_len`, clean at `max_len - 4`. Not in the original entry. |
| `read_exact` returned `TIMEOUT` after a partial read | **Fixed** — it now only reports a timeout when nothing has been consumed. Mid-packet it keeps waiting, because returning there leaves the remainder in the socket and desyncs the stream exactly like the oversize path. This one *could* fire, for calibration's 3 s timeout. Not in the original entry. |
| The read path never marked a dead socket dead | **Fixed.** Only `_write_all` cleared `connected_`, so a read-only consumer saw `is_connected()` report true forever on a closed socket and `heartbeat_service`'s "reconnect on next iteration" never fired. |
| Nothing tested the Elodin read path | **Fixed.** `test_elodin_read_path` drives a fake elodin-db it controls, since nothing a real db emits is large enough to reach these paths. Verified to have teeth: 5 of its 9 assertions fail against the pre-fix client. `test_sequencer_elodin` — built since it was added but never registered with CTest, the same problem already fixed for `test_robust_ddp` — is now registered. |
| Nothing tested `engine_state` end to end | **Fixed.** `ws_data_flow_test.ts` Test 7 counted heartbeat packets and asserted nothing about their contents. It now drives a transition to FUEL_FILL and asserts `engine_state` follows. Verified to have teeth: with the subscription reverted the run reports `92 passed, 1 failed` and exits 1. |

### By the DAQ-NIC pinning work (2026-09-07)

Filed as two entries — "the ABORT broadcast can leave on the wrong interface" and "the abort
broadcast port ignores config". Both were symptoms of one thing, and the scope was wrong: the
defect was never abort-specific. **No socket in the DAQ path pinned its egress interface.** That
was invisible while the DAQ owned its machine and became real when it moved onto the shared apps
box (`04709920`), which now carries the board LAN, the site LAN and a Docker bridge.

| Item | Resolution |
|---|---|
| No board-facing socket bound a local address | **Fixed.** New `fsw::net::resolveDaqBindAddress()` (`lib/include/net/DaqInterface.hpp`) picks the interface whose subnet holds the configured boards, mirroring the rule `deploy/bootstrap_daq.sh:149` already used in shell. Applied to the sequencer's actuator + abort sockets, `heartbeat_service`, `config_broadcast_service`, the controller's PWM output, `FSWConfigManager` (send and receive), `daq_bridge`'s sensor listener and the OTA TCP client. Each service logs the address it pinned. |
| `[network].bind_ip` existed but only one socket honoured it | **Fixed.** It is now *the* override, consulted by every board-facing socket, and a value that is not an address on the host fails startup rather than degrading to `0.0.0.0`. Two interfaces on the board subnet also fails, naming both — guessing between them is the original defect. |
| `[actuator_service].bind_address` shipped as `0.0.0.0`, so `ActuatorCommander`'s `bind()` constrained nothing | **Fixed.** Kept as an explicit per-service override; when unset it takes the resolved NIC. |
| `FSWConfigManager` hardcoded `"0.0.0.0", 5008` two lines from where `bind_ip` was parsed | **Fixed.** Uses the same address as the sensor pipeline. |
| ABORT sent to the limited broadcast `255.255.255.255` | **Fixed.** Destination comes from `[server_heartbeat].broadcast_ip`, already `192.168.2.255` in every shipped profile and `127.0.0.255` in sim — no config file needed changing. Subnet-directed resolves to exactly one route; limited broadcast does not. Confirmed safe on hardware in principle: the boards program `subnet(255,255,255,0)` into the W5500 and `SERVER_HEARTBEAT` already flows to `192.168.2.255` and is acted on. **Still wants one bench observation before the rig relies on it.** |
| Abort broadcast port and ABORT_DONE delay were ctor defaults | **Fixed.** `AbortBroadcaster::configure()` is called from `SequencerService::init()` beside `fire_manager_.configure()`. The address is resolved once there, not inside the abort path. |
| No test observed an abort broadcast | **Fixed, and it has teeth.** `test_abort_ordering` now writes `[server_heartbeat]` into its config and binds what it wrote, so it covers routing as well as ordering — verified by disabling `configure()`, which sends to `255.255.255.255:5005` and fails the test. The integration run confirms all five services pin to `lo` and the abort reaches `127.0.0.1:5015`. |
| The resolver itself was untested | **Fixed.** `test_daq_interface` pins all four outcomes using RFC 5737 addresses so results do not depend on the host. The ambiguous case is deliberately not tested — producing it means assigning an address to the machine. |
| `fix_ethernet_interface.sh` printed `.20` and assigned `.201` | **Fixed.** It assigns `192.168.2.20` (what the firmware targets) and its verification is anchored, so `.201` can no longer pass as `.20`. |
| `[discovery].network_interface = "auto"` documented as selecting the board NIC | **Corrected.** `BoardDiscovery` stores it and only prints it; the docs now point at the resolver instead. |

Not fixed, deliberately: `PressureStateMachine`'s command socket. Nothing constructs that class —
pinning a socket that never opens is churn — so it carries a comment pointing at the resolver
instead.

### By the config draft-only work (2026-09-07)

| Item | Resolution |
|---|---|
| Sequencer hot-reloads config mid-run (`RELOAD_CONFIG`) | **Removed, not fixed.** The command, `reloadConfig()`/`doReloadConfig()` and the backend's sender are gone. Its only caller fired when the CSV was *deployed*, which only happens with no session active — so it could never reach a running sequencer. Deleting the path is strictly better than making it safe: it also removes the reload half of the work in `0c0dfd6c`. |
| `reloadConfig()` raced the republish loop / kept stale `[fire]` ids | **Moot.** Both were fixed in `0c0dfd6c`; the function they lived in no longer exists. `applyFireConfig()` stays, called from `init()` only. |
| Sequencer re-parsed config on every Elodin reconnect | **Fixed.** `tryConnectElodin()` uses an actuator-board snapshot taken at `init()`. A db restart mid-run no longer rebuilds the actuator tables from whatever is on disk at that moment. |
| Backend re-read config.toml per request / per command / per resubscribe retry | **Fixed.** `readDeployedConfig()` caches the parsed deployed config, invalidated inside `deployActiveProfile()` — the single apply point. Not a boot-time read: the backend is always-on and must still notice a deploy. |
| A failed deploy at session start only warned | **Fixed.** Session start now aborts with an operator-facing error. Running on stale config behind a green "session active" light was the worst available outcome. |
| Config editor said "saved" for a draft | **Fixed.** Save / import / CSV upload use the API's own `deployed` flag and message, amber for a draft. A new banner counts un-applied changes (`GET /api/config/profiles` → `undeployed`) with a link to compare against the running config. |
| `patchBoardField()` silently reverted at the next deploy | **Fixed.** Board log mode stays live (the documented exception) but now writes the active profile too, so it survives a deploy. |
| Board-config live reload was undocumented | **Documented as the one deliberate exception**, in `config_broadcast_service_main.cpp` and `docs/CONFIGURATION_GUIDE.md` — including that `[abort_pts]` and `boards.*.enabled` reach hardware live. |
| Sim runs silently ignore config drafts | **Documented.** Kept deliberate — a sim run must behave the same on every box — and the session page now says so when Simulated is selected. |
| `CONFIGURATION_GUIDE.md` stale; `SENSOR_ASSIGNMENT_SYSTEM.md` describes an unshipped design | **Fixed.** Guide rewritten around profile/deploy/session-start plus the two exceptions; the sensor-assignment doc carries an "aspirational, not shipped" banner. |

### By the sequencer concurrency work (2026-09-07, `0c0dfd6c` / `4bcbfb4e`)

| Item | Resolution |
|---|---|
| `SequencerService` serializes nothing | **Fixed.** All commands now run on a single worker thread fed by a queue; the fire-expiry callback posts to it without waiting. Confirmed: the pre-fix binary dies under TSan in 0.2 s at ~50 commands with a double `pthread_join` inside `stopContinuousLoop`, the post-fix one runs 240 transitions clean. A mutex was tried first and does not work — `fire_manager_.stop()` joins the very thread that would be waiting on it. Guarded by `test_sequencer_concurrency` under the new TSan job. |
| `reloadConfig()` rewrites the actuator tables while the 1 Hz loop reads them | **Fixed.** The republish loop is stopped before `ActuatorCommander::load()` and restarted after. |
| `reloadConfig()` keeps stale `[fire]` ids after re-adopting `[[states]]` | **Fixed.** The `[fire]` resolution was extracted to `applyFireConfig()` and is now called from both `init()` and reload, so a renumbering reload re-resolves the burn state, the expiry target and the window. |
| ABORT queued behind the sequencer's own housekeeping | **Fixed.** `triggerAbort()` is now the first thing `transitionTo()` does, ahead of the republish-thread join, the controller notification and the actuator batch. Measured 453 ms → 0 ms with an unreachable controller; `test_abort_ordering` pins it. |
| ABORT sent as a single unacknowledged datagram | **Fixed.** Sent 4× at 2 ms spacing with a send timeout and per-repeat `errno` logging. The *routing* half is resolved separately below. |
| `notifyControllerFire` has no connect timeout | **Fixed.** Non-blocking connect with a 300 ms deadline, consulting `SO_ERROR` on any poll readiness so a refused connection is not mislabelled a timeout. Measured on this box: blocking connect to a blackholed host took **133,348 ms**; bounded version returns in **301 ms**. |
| Actuator UDP sends have no timeout and log nothing | **Fixed.** `SO_SNDTIMEO` of 100 ms on the batch socket, and a short send now names the board IP and `strerror(errno)` instead of only flipping a boolean. |
| Detached threads outlive the objects they reference | **Fixed.** Client threads are bounded (64) and joined before `svc` goes out of scope; the accept loop reaps finished ones and refuses over-limit connections with `ERR:too many connections` rather than a bare close, which reached the client as a TCP reset. |
| `test_robust_ddp` built but never run | **Fixed.** Registered with CTest (`add_test(NAME robust_ddp …)`) and passing. |
| Integration test dialled the wrong controller port | **Fixed.** `test_integration.sh` now rewrites `[controller_service].port` to `$TEST_CONTROLLER_PORT`, and `ws_data_flow_test.ts` asserts the controller actually logged FIRE_START and FIRE_STOP — previously the sequencer sent to 9999 while the controller listened on 9997 and the suite passed anyway. |

### Since the April 2026 revision

| Item | Resolution |
|---|---|
| FireManager `extend()` timer data race | **Fixed.** `current_duration_ms_` is `std::atomic<uint32_t>` and `extend()` now writes the duration *before* raising `cancel_` (`FireManager.cpp:66-73`), so the timer thread re-reads the new value. `stop()` also handles the joinable-but-inactive thread that used to `std::terminate` on restart. |
| Errors to the controller service silently dropped | **Mostly fixed.** Actuator, state-transition, and extend-fire commands now surface `MessageType.ERROR` to the originating client on failure. One `.catch(() => { })` survives on the `debug_mode` path (`server.ts:1000`). |
| Fragile regex fallback in TOML `actuator_roles` parsing | **Fixed.** The backend uses `smol-toml`, which handles the mixed-type inline arrays natively; the hand-rolled regex parser is gone. |
| Catch-all `catch (...)` in `SequencerService` | **Fixed** — those handlers no longer exist. |
| Integration test: hardcoded ports, no conflict detection | **Fixed.** All ports are `${TEST_*_PORT:-default}` and the script sweeps them before starting. |
| Frontend API responses typed as `any` | **Largely fixed.** `dashboard-hooks.ts` is clean; roughly twenty `any` occurrences remain across the whole frontend, mostly local. Not worth a backlog entry on its own. |
| Startup race: "controller never gets service" after reloading the UI during startup | **Superseded, unconfirmed.** The specific hypothesis was about the Next.js SPA's connection lifecycle, which no longer exists after the Vite migration. The Elodin side of the startup race was addressed independently by the retry loop at `SequencerService.cpp:620`. Re-file with fresh evidence if it recurs. |

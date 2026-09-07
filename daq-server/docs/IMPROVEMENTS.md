# DAQ Server — Improvement Backlog

Known defects and improvement work across the C++ services, the TypeScript backend, the
frontend, and CI. Each item names the affected file(s), what actually goes wrong, and the
shape of the fix.

**Last audited:** 2026-09-07 against `ab3ce2d2`.
**Last updated:** 2026-09-07 — the sequencer concurrency work and the config draft-only work both
landed; their items moved to Resolved.

The revision before this one dated from April 2026 and predated the Vite frontend migration,
the `smol-toml` config work, and the config-driven `[[states]]` rework. Anything fixed is
recorded at the bottom with *how*, rather than silently dropped, so a future audit can tell
"resolved" from "never looked at".

---

## Critical

### C++ — The ABORT broadcast can leave on the wrong interface

**File:** `diablo_server/services/sequencer/AbortBroadcaster.cpp`

*Partly addressed.* The abort is no longer a single datagram — it is sent 4× at 2 ms spacing
with a send timeout and per-repeat `errno` logging, matching the redundancy
`ActuatorCommander::sendBatch` already had for ordinary state changes.

What remains is routing. `dest.sin_addr.s_addr = INADDR_BROADCAST` (255.255.255.255) with no
`SO_BINDTODEVICE` and no bind to the DAQ NIC. On the apps box, which has more than one
interface, the kernel picks the egress interface by route. If the DAQ NIC is not the one
chosen, all four repeats leave on the wrong wire together — redundancy does not help when the
failure is common-mode.

**Fix:** bind the socket to the configured DAQ interface address, or send to the
subnet-directed broadcast address (`192.168.2.255`) rather than the limited broadcast address,
so it cannot take the wrong route. See also the entry below on the hardcoded abort port — both
are the same underlying gap, that the broadcaster is constructed with no knowledge of config.

---

### C++ — `read_packet` desynchronizes the Elodin stream on an oversized packet, and the heartbeat buffer guarantees it

**Files:** `diablo_server/lib/src/elodin/ElodinClient.cpp:236-240`,
`diablo_server/services/heartbeat/heartbeat_service_main.cpp:105`

`read_packet` reads the 8-byte header, and if `packet_len > max_len` it returns `-1` —
**without draining the `packet_len - 4` payload bytes it just committed to reading and
without disconnecting.** The socket is now permanently misaligned: every subsequent read
interprets payload bytes as a header. The client never recovers, and because the connection
is still "connected", callers that `continue` on `-1` spin at 100% CPU.

The heartbeat service is the guaranteed trigger. It subscribes to the whole stream
(`subscribe_stream()`) with a **256-byte** buffer. The calibration service, which learned
this the hard way, uses 64 KB and says so in a comment
(`calibration_main.cpp:1022`: *"64 KB — handles large Elodin subscription-ACK bursts"*). The
heartbeat gets one subscription ACK burst or one large vtable packet and its state tracking
is dead for the lifetime of the process — while it keeps broadcasting SERVER_HEARTBEAT with
a frozen `engine_state`.

**Fix:** in `read_packet`, on an oversized packet either drain-and-skip the payload (read it
in chunks into a scratch buffer and return 0 for "skipped") or mark the connection failed so
the caller reconnects — never leave a half-read packet on the socket. Raise the heartbeat
buffer to match calibration's. In `elodinThread`, treat a persistent `-1` as a disconnect
rather than looping.

---

### C++ — Heartbeat maps sequencer states through a hardcoded enum table

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

### C++ — The controller's FIRE gate is a single-threaded accept loop with no receive timeout

**File:** `diablo_server/services/controller/controller_main.cpp:60-123`

`runControlServer` accepts a connection and then reads it **inline**, byte by byte, with a
blocking `recv` and no `SO_RCVTIMEO`. There is no per-client thread. A client that connects
and sends no newline blocks the accept loop indefinitely — and this loop is the only path
that opens and closes the PWM gate.

`sequencer_main.cpp:154` sets a 5 s `SO_RCVTIMEO` and gives each client its own thread; the controller,
which gates ignition, does neither.

**Failure scenario:** the backend host is killed or drops off the network mid-connection.
The controller sits in `recv`. The next FIRE_STOP is never accepted, and the PWM gate stays
open until the process is killed.

**Fix:** set `SO_RCVTIMEO` on the accepted socket and handle the client on a short-lived
thread, mirroring `sequencer_main`. A cap on concurrent clients is worth having too.

---

### C++ — The controller falls back to hardcoded actuator channels when role names don't match

**File:** `diablo_server/services/controller/controller_main.cpp:236-279`

The controller looks up the literal role names `"Fuel Press"` and `"LOX Press"` in
`[actuator_roles]`. If either is missing it prints a warning and **proceeds** with
`CH3/board 12` and `CH8/board 12`.

The config editor lets roles be renamed. A rename means the controller drives PWM on
whatever hardware happens to sit on those channels of board 12.

This is the same hazard as the state-id bugs, and the fix pattern is already in this very
file: the fire-state gate a few lines down (`controller_main.cpp:341-363`) deliberately
*disables itself* rather than fall back to a compiled id, with the comment "fail safe and
loud, not silent-wrong". The actuator lookup should follow the same rule.

Related, same block: `pwm.actuator_board_ip` holds **one** IP. If Fuel Press and LOX Press
resolve to different boards, the code warns and uses the fuel board's IP for both — so LOX
PWM commands are addressed to the wrong board. `PWMConfig` needs a per-channel IP.

**Fix:** if either role is absent, refuse to open the PWM gate (the `setFireStateId(255)`
pattern) instead of substituting defaults. Make the role names config keys rather than
literals.

---

### Backend — WebSocket broadcast has no backpressure and no keepalive

**File:** `diablo_server/backend/src/server.ts:676-690`

`broadcast()` sends to every client whose `readyState === OPEN` and swallows the result.
Nothing checks `ws.bufferedAmount`, and there is no `ping`/`pong` liveness check anywhere in
the server (`grep bufferedAmount` and `grep ping(` both come back empty).

Two consequences, both routine in the field:

1. A client on a degraded link (a tablet at the pad) stops draining. `ws` queues every
   broadcast in the backend's heap. At 10 Hz across every sensor series, that grows without
   bound.
2. A client whose network vanishes without a TCP FIN — a Wi-Fi drop, a closed laptop —
   stays `OPEN` in `wss.clients` indefinitely and keeps accruing that queue, because
   nothing ever probes it.

The backend is the single process feeding every dashboard; when it OOMs, everyone loses
telemetry at once.

**Fix:** skip clients over a `bufferedAmount` threshold (drop frames for that client rather
than the whole server — sensor data is idempotent, the next frame supersedes it), and
`terminate()` a client that stays over the threshold for several seconds. Add the standard
30 s `ping` with an `isAlive` flag cleared on `pong` to reap dead sockets.

---

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

### C++ — the abort broadcast port ignores config

**Files:** `diablo_server/lib/include/control/SequencerService.hpp:144`,
`diablo_server/lib/include/control/AbortBroadcaster.hpp:22`, `config/config.toml:8,16`

`AbortBroadcaster abort_broadcaster_;` is default-constructed — port 5005, ABORT_DONE delay
3000 ms — and nothing in `SequencerService::init()` or `reloadConfig()` ever configures it.
`broadcast_port` exists in config (two sections, both defaulting to 5005) and
`fsw::config::Config` parses it, but the sequencer's abort path never reads it.

A rig that moves `broadcast_port` gets actuator config broadcasts on the new port and aborts on
5005. `test/test_integration.sh:395` already remaps `broadcast_port` to the test port, so under
test the abort broadcast goes somewhere nothing is listening — which is part of why no test has
ever observed one.

**Fix:** construct the broadcaster from `cfg.<section>.broadcast_port` in `init()`, alongside the
other config-derived values. Same for the ABORT_DONE delay if a config key is wanted for it.
(There is no reload path to keep in sync any more — config is read once at startup.)

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
| ABORT sent as a single unacknowledged datagram | **Fixed.** Sent 4× at 2 ms spacing with a send timeout and per-repeat `errno` logging. The *routing* half of that entry is still open — see "The ABORT broadcast can leave on the wrong interface". |
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

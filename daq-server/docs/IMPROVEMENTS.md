# DAQ Server — Improvement Backlog

Known defects and improvement work across the C++ services, the TypeScript backend, the
frontend, and CI. Each item names the affected file(s), what actually goes wrong, and the
shape of the fix.

**Last audited:** 2026-09-07 against `ab3ce2d2`.
The previous revision of this file dated from April 2026 and predated the Vite frontend
migration, the `smol-toml` config work, and the config-driven `[[states]]` rework. Items it
listed that are now fixed are recorded at the bottom rather than silently dropped, so a
future audit can tell "resolved" from "never looked at".

---

## Critical

### C++ — `SequencerService` serializes nothing; every command path is concurrent

**Files:** `diablo_server/services/sequencer/SequencerService.cpp:243` (`transitionTo`),
`diablo_server/services/sequencer/sequencer_main.cpp:215`

`sequencer_main` spawns **one detached thread per TCP client** and every one of them calls
into the same `SequencerService` instance. The `FireManager` timer thread is a third caller
(`SequencerService.cpp:294`, `transitionTo(fire_expiry_state_)`). There is no mutex anywhere
in the class — only `std::atomic` on the individual fields, which protects each load and
store but not the multi-step sequence built out of them.

`transitionTo` is that sequence: clear overrides → `stopContinuousLoop()` →
`applyForState()` → `startContinuousLoop()` → assign `current_state_` → maybe
`triggerAbort()` → maybe `fire_manager_.start()`. Two threads running it at once interleave
arbitrarily.

The sharpest failure is not a logical race but a hard crash. `stopContinuousLoop()` joins
`loop_thread_`; `startContinuousLoop()` move-assigns into it. Two threads doing that
concurrently means either two `join()` calls on the same `std::thread` (undefined behavior)
or a move-assignment into a still-joinable thread, which calls `std::terminate` — the exact
failure `FireManager::stop()` documents at `FireManager.cpp:41-46` and guards against
single-threaded, but which nothing guards against across threads.

**Failure scenario:** two dashboards are open. The fire timer expires at the same moment an
operator presses ABORT. Both threads enter `transitionTo`. The sequencer dies with
`terminate called without an active exception` — during a burn, with the actuator republish
loop dead and no process left to command the abort state.

**Fix:** a single `std::recursive_mutex` held across the whole body of `transitionTo`,
`setDebugMode`, `manualActuator`, `extendFire`, and `reloadConfig`. Recursive because the
fire-expiry callback re-enters `transitionTo` from inside `FireManager`'s timer thread while
`stop()` may be unwinding. Commands are human-rate; there is no throughput argument against
a service-wide lock here.

---

### C++ — `reloadConfig()` rewrites the actuator tables while the 1 Hz loop is reading them

**Files:** `diablo_server/services/sequencer/SequencerService.cpp:338`,
`diablo_server/services/sequencer/ActuatorCommander.cpp:58`

`reloadConfig()` calls `actuator_commander_.load(...)`, whose first two statements are
`roles_.clear(); state_actuators_.clear();` — followed by a full repopulate from CSV. It
does **not** stop the continuous loop first. That loop
(`ActuatorCommander.cpp:493`) is calling `applyForState()` → `findStateActuators()` →
iterating `state_actuators_` once a second, forever.

Neither `roles_` nor `state_actuators_` is guarded by a mutex (the class has
`pending_roles_mutex_` and `overrides_mutex_`, which cover different members).
Clearing and rebuilding a `std::map` under an active iterator is undefined behavior, not a
stale read.

`state_machine_.load(sm_csv)` on the next line has the same problem against any concurrent
`transitionTo` reading the transition table.

**Failure scenario:** an operator saves a config edit from the GUI (which sends
`RELOAD_CONFIG`) during a fill. The republish loop is mid-iteration. The sequencer segfaults
or sends actuator commands built from freed nodes.

**Fix:** in `reloadConfig()`, stop the continuous loop, swap the tables, restart the loop —
all under the service-wide lock from the item above. Better still, build the new
`ActuatorCommander` state off to the side and swap it in under a lock, so a failed reload
cannot leave the tables half-cleared (today a mid-load `return false` leaves the service
with an empty actuator map and a running loop).

---

### C++ — `reloadConfig()` re-adopts `[[states]]` but keeps the old fire state ids

**File:** `diablo_server/services/sequencer/SequencerService.cpp:338-360`

`reloadConfig()` calls `StateMachine::loadStatesFromConfig(config_content_)` — renumbering
every state — but never re-reads `[fire]`. `fire_state_` and `fire_expiry_state_` are stored
as `State` values (raw ids) resolved once in `init()`. After a reload that renumbers or
renames states, both hold ids that now name *different* states, and
`actuator_commander_.setFireState()` is never called again either.

`fire_manager_.configure(duration, extended)` is also not re-applied, so an edited fire
window silently doesn't take effect until the service restarts.

This is the same class of bug as the ones already fixed in `init()`, the controller, and the
backend — the reload path just never got the same treatment.

**Failure scenario:** a rig adds a state, which shifts ids. Config is reloaded rather than
the stack restarted. `to == fire_state_` in `transitionTo` now matches the wrong state: the
fire countdown arms on entering some fill state, and entering the real fire state arms
nothing.

**Fix:** factor the `[fire]` resolution block out of `init()` (`SequencerService.cpp:144-191`,
including the `isAllowed` sanity warning) and call it from both `init()` and
`reloadConfig()`.

---

### C++ — ABORT is a single unacknowledged UDP datagram

**File:** `diablo_server/services/sequencer/AbortBroadcaster.cpp:39-73`

`sendPacket()` sends the ABORT header exactly once and reports success if `sendto` accepted
it. One dropped frame on a congested field network and no board ever hears the abort.

The contrast inside the same service is stark: `ActuatorCommander::sendBatch` sends **three
rounds 1 ms apart** for ordinary state changes precisely because a single UDP send is not
trusted. The abort path — the one that matters most — sends one.

Related, same function: `dest.sin_addr.s_addr = INADDR_BROADCAST` (255.255.255.255) with no
`SO_BINDTODEVICE` and no bind to the DAQ NIC. On the apps box, which has more than one
interface, the kernel picks the egress interface by route. If the DAQ NIC is not the one
chosen, the abort broadcast leaves on the wrong wire.

**Fix:** send the abort 3–5 times a few ms apart, matching `sendBatch`. Bind the socket to
the configured DAQ interface address (or send to the subnet-directed broadcast address,
`192.168.2.255`, rather than the limited broadcast address) so it cannot take the wrong
route. Log `errno` on a short send instead of only a generic "failed".

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

`sequencer_main.cpp:48` sets a 5 s `SO_RCVTIMEO` and threads per client; the controller,
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

**File:** `diablo_server/backend/src/server.ts:677-690`

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

### CI — No sanitizer build, and CMake sets no warning flags

**Files:** `CMakeLists.txt`, `.github/workflows/daq-server-ci.yml`

The top-level `CMakeLists.txt` sets no `-Wall`/`-Wextra` and offers no sanitizer option;
nothing in CI builds with ASan, UBSan, or TSan. Every C++ item in the Critical section above
is a data race or an unaligned/undefined access that a sanitizer run would have surfaced
automatically.

A concrete UBSan-visible instance today:
`config_broadcast_service_main.cpp:351,360,363` do
`*reinterpret_cast<uint32_t*>(&buf[off])` into a `std::vector<uint8_t>` at offsets that step
by 7 and 9 — unaligned stores through a `uint32_t*`. It works on x86-64 and ARM64 and is
still undefined behavior; `memcpy` compiles to the same instruction with none of the risk.

**Fix, in priority order:**
1. A **TSan** CI job running the existing ctest suite plus a scripted burst of concurrent
   sequencer commands. This is where the value is — the races above are the real bugs.
2. `add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter)` in the top-level
   `CMakeLists.txt`, with `-Werror=return-type` at minimum.
3. A `-DSANITIZE=ON` option wiring `-fsanitize=address,undefined`, run over ctest.

---

## Medium

### Backend — WebSocket commands are still parsed as `any`

**File:** `diablo_server/backend/src/server.ts:892` (`handleMessage(ws, message: any)`)

Real gates have been added since this was first written — `CONTROL_COMMAND_TYPES` requires
an armed operator connection (`server.ts:935`), and `state_transition` now rejects ids the
active config doesn't declare (`server.ts:943-970`). Those close the two exploitable holes.

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

### C++ — Actuator UDP sends have no timeout and log nothing on failure

**File:** `diablo_server/services/sequencer/ActuatorCommander.cpp:309-332`

The batch socket is created without `SO_SNDTIMEO`. A `sendto` on a saturated interface with
a full socket buffer blocks the calling thread — which, via `applyForState`, is either the
republish loop or a command thread.

Worse for diagnosis: a short send only sets `all_ok = false`. `errno` is never read and
nothing is logged, so a partially-delivered abort or state change leaves no trace beyond a
boolean the callers largely ignore.

**Fix:**

```cpp
struct timeval tv{.tv_sec = 0, .tv_usec = 100000};  // 100 ms
setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
```

and log the board IP plus `strerror(errno)` on any send that doesn't complete.

---

### C++ — `notifyControllerFire` has a send timeout but no connect timeout

**File:** `diablo_server/services/sequencer/SequencerService.cpp:372-397`

`SO_SNDTIMEO` is set, but `connect()` on a blocking socket ignores it — an unreachable host
that drops SYNs takes the full kernel retry budget (~2 minutes) before returning. This runs
on whichever thread called `transitionTo` → `fire_manager_.start()`, so a controller host
that is powered off but still ARP-resolvable stalls the state transition itself.

**Fix:** non-blocking `connect` + `select` with a ~500 ms deadline, then restore blocking
mode for the `send`. Or set `TCP_SYNCNT` to 1–2.

---

### C++ — Detached threads outlive the objects they reference

**Files:** `diablo_server/services/sequencer/sequencer_main.cpp:215-217`,
`diablo_server/services/controller/controller_main.cpp:412-413`

Both services detach threads that capture a stack-allocated service by reference
(`&svc`, `&service`) and then let `main` return. On SIGTERM the detached threads may still
be inside `recv`/`accept` when the service destructor runs.

In practice the process is exiting anyway, so this shows up as an occasional ugly crash in
the shutdown logs rather than a field failure — but it also means shutdown logs can't be
trusted as a signal that something is wrong.

**Fix:** track the client threads in a vector and join them after the accept loop exits, or
give the service static storage duration. In the controller's case `control_thread` is
already a named `std::thread` — join it instead of detaching.

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

### Tests — `test_robust_ddp` is built but never run; `test_imu_calibration` is never built

**Files:** `diablo_server/lib/CMakeLists.txt:52`,
`diablo_server/lib/test/test_imu_calibration.cpp`, `.github/workflows/daq-server-ci.yml`

`add_executable(test_robust_ddp …)` has no matching `add_test`, and CI never invokes the
binary directly (the way it does for `test_sequencer_elodin`). It compiles on every build
and its assertions have never gated anything.

`test_imu_calibration.cpp` has no `add_executable` at all — it isn't compiled, so it can
silently rot out of sync with the code it tests.

**Fix:** `add_test(NAME robust_ddp COMMAND test_robust_ddp)`. For the IMU test, either wire
it up or delete it; a test file that isn't built is worse than no test file, because it reads
like coverage.

---

### C++ — the abort broadcast port ignores config

**Files:** `diablo_server/lib/include/control/SequencerService.hpp:144`,
`diablo_server/lib/include/control/AbortBroadcaster.hpp:21`, `config/config.toml:8,16`

`AbortBroadcaster abort_broadcaster_;` is default-constructed — port 5005, ABORT_DONE delay
3000 ms — and nothing in `SequencerService::init()` or `reloadConfig()` ever configures it.
`broadcast_port` exists in config (two sections, both defaulting to 5005) and
`fsw::config::Config` parses it, but the sequencer's abort path never reads it.

A rig that moves `broadcast_port` gets actuator config broadcasts on the new port and aborts on
5005. `test/test_integration.sh:395` already remaps `broadcast_port` to the test port, so under
test the abort broadcast goes somewhere nothing is listening — which is part of why no test has
ever observed one.

**Fix:** construct the broadcaster from `cfg.<section>.broadcast_port` in `init()`, and re-apply
it in `applyFireConfig()`/reload alongside the other config-derived values. Same for the
ABORT_DONE delay if a config key is wanted for it.

---

### Tests — the integration test points the sequencer at the wrong controller port

**Files:** `test/test_integration.sh:62,625`, `config/config.toml:393-394`

The script launches `controller_service` with `--control-port 9997`, but never rewrites
`[controller_service].port` in the generated test config, which stays at the base value `9999`.
The sequencer reads that key for `controller_port_`, so it dials 9999 while the controller
listens on 9997.

Result: `FIRE_START` / `FIRE_STOP` never reach the controller during the integration run, and
nothing asserts that they should — the run passes with the sequencer→controller fire gate
entirely uncovered. Confirmed in a live run: the sequencer log shows *"could not reach
controller_service at 127.0.0.1:9999 for FIRE_START"* while the controller log shows
*"Control server on TCP :9997"*, and the suite still reported PASS.

The mechanism itself is covered by the `test_fire_lifecycle` unit test, which stands up its own
listener — so this is a wiring gap in the integration harness, not an untested code path.

**Fix:** rewrite `[controller_service].port` to `$TEST_CONTROLLER_PORT` alongside the other
`sedi` port rewrites (~`test_integration.sh:368-410`), and add an assertion that the controller
actually observed the fire gate open and close.

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

## Resolved since the April 2026 revision

Kept so a future audit can distinguish "fixed" from "never checked". Verified against
`ab3ce2d2`.

| Item | Resolution |
|---|---|
| FireManager `extend()` timer data race | **Fixed.** `current_duration_ms_` is `std::atomic<uint32_t>` and `extend()` now writes the duration *before* raising `cancel_` (`FireManager.cpp:66-73`), so the timer thread re-reads the new value. `stop()` also handles the joinable-but-inactive thread that used to `std::terminate` on restart. |
| Errors to the controller service silently dropped | **Mostly fixed.** Actuator, state-transition, and extend-fire commands now surface `MessageType.ERROR` to the originating client on failure. One `.catch(() => { })` survives on the `debug_mode` path (`server.ts:1001`). |
| Fragile regex fallback in TOML `actuator_roles` parsing | **Fixed.** The backend uses `smol-toml`, which handles the mixed-type inline arrays natively; the hand-rolled regex parser is gone. |
| Catch-all `catch (...)` in `SequencerService` | **Fixed** — those handlers no longer exist. |
| Integration test: hardcoded ports, no conflict detection | **Fixed.** All ports are `${TEST_*_PORT:-default}` and the script sweeps them before starting. |
| Frontend API responses typed as `any` | **Largely fixed.** `dashboard-hooks.ts` is clean; roughly twenty `any` occurrences remain across the whole frontend, mostly local. Not worth a backlog entry on its own. |
| Startup race: "controller never gets service" after reloading the UI during startup | **Superseded, unconfirmed.** The specific hypothesis was about the Next.js SPA's connection lifecycle, which no longer exists after the Vite migration. The Elodin side of the startup race was addressed independently by the retry loop at `SequencerService.cpp:438-451`. Re-file with fresh evidence if it recurs. |

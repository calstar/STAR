# DAQ Server — Improvement Backlog

Known defects and improvement work across the C++ services, the TypeScript backend, the
frontend, and CI. Each item names the affected file(s), what actually goes wrong, and the
shape of the fix.

**Last audited:** 2026-09-07 against `ab3ce2d2`.
**Last updated:** 2026-09-07 — the Elodin subscription work landed (and withdrew this file's
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

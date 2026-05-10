# Codebase Improvement Backlog

Identified issues across the frontend, backend, C++ services, build system, and deployment scripts.
Each item includes the affected file(s), a description of the problem, and a suggested fix.

---

## Critical

### C++ — FireManager timer data race
**File:** `diablo_server/services/sequencer/FireManager.cpp:56-63`

`extend()` sets `cancel_ = true` then updates `current_duration_ms_` while the timer thread reads both without holding a lock. The sequence is:
1. Timer thread reads `cancel_` — sees false, proceeds.
2. Caller sets `cancel_ = true`, updates duration.
3. Timer thread uses the old duration.

The duration update is silently lost, meaning the fire window doesn't extend as commanded. In a live fire this is safety-critical.

**Fix:** Guard the entire `extend()` / timer-tick path with a `std::mutex`. Use a `std::condition_variable` to wake the timer thread when a new duration arrives rather than spinning on `cancel_`.

---

### Backend — No input validation on WebSocket commands
**File:** `diablo_server/backend/src/server.ts:735`

`handleMessage(ws, message: any)` accepts arbitrary JSON from clients with no schema check. Fields like `commandType`, `state`, and `actuatorState` are accessed with non-null assertions (`!`) or cast through `unknown`. A malformed or malicious message can cause unhandled exceptions or drive the sequencer into an undefined state.

**Fix:** Define a discriminated union type for all incoming message shapes. Validate at the parse boundary — either manually or with `zod`. Reject and log any message that doesn't match the schema before it touches any business logic.

---

## Medium

### Frontend — Verbose `console.log` statements in production builds
**Files:** `lib/websocket.ts:100,109,111,114,212,220,390`, `UnifiedDashboard.tsx:104`, `IpadDashboard.tsx:99`, `StateMachineDiagram.tsx:283`

Debug logs fire on every WebSocket message, every state change, and every time-window button click. In a live session with 10 Hz sensor data this is hundreds of log lines per second, slowing the browser's console and masking real errors.

**Fix:** Introduce a minimal logger wrapper:
```ts
const logger = {
  debug: (...a: any[]) => process.env.NODE_ENV !== 'production' && console.log(...a),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};
```
Replace all `console.log` in library code with `logger.debug`. Keep `console.error` for genuine errors.

---

### Frontend — No error boundaries anywhere in the app
**File:** `diablo_server/frontend/app/layout.tsx`

If any component throws during render (bad sensor data, missing config field, etc.) the entire page goes blank with no user-facing message. This has already happened with the `ActuatorId` crash — the whole dashboard was unusable.

**Fix:** Add a top-level `<ErrorBoundary>` in `layout.tsx` that shows a "Something went wrong" message with a reload button. Add finer-grained boundaries around the plots panel, the actuator grid, and the state machine diagram so a failure in one section doesn't kill the others.

---

### Backend — Errors to controller service are silently dropped
**File:** `diablo_server/backend/src/server.ts:792,794,847,851`

```ts
sendToControllerService(...).catch(() => {});
```

If the controller service TCP connection is down, the actuator command or abort just disappears. The frontend shows success (or nothing), and the operator has no idea the command was never delivered. For an abort command this is a safety issue.

**Fix:** In the catch handler, log the failure with `console.error` and send a `MessageType.ERROR` message back to the originating WebSocket client:
```ts
.catch(err => {
  console.error('[server] failed to reach controller service:', err);
  ws.send(JSON.stringify({ type: MessageType.ERROR, payload: { message: 'Controller unreachable' } }));
});
```

---

### Backend — Fragile regex fallback in TOML actuator_roles parsing
**File:** `diablo_server/backend/src/routes/config.ts:52-110`

When a standard TOML parse fails (because `actuator_roles` uses mixed-type arrays like `["Normally Closed", 1, 2]`), the code falls back to a hand-rolled regex parser. If the format drifts even slightly (extra whitespace, quoted numbers, nested structure) the regex silently returns partial results with no error. A one-time warning flag is set but is easy to miss in logs.

**Fix:** Use a TOML parser that natively handles heterogeneous arrays (e.g., `smol-toml`), or enforce a strict array format in the config schema and throw a clear error at startup if it doesn't match. Remove the regex fallback entirely.

---

### C++ — Socket operations in ActuatorCommander have no send timeout
**File:** `diablo_server/services/sequencer/ActuatorCommander.cpp`

UDP send calls have no `SO_SNDTIMEO` set on the socket. If the network interface is saturated or the destination is unreachable, `sendto()` can block the service thread indefinitely, stalling all actuator commands including aborts.

**Fix:** After `socket()`, set a send timeout:
```cpp
struct timeval tv { .tv_sec = 0, .tv_usec = 100000 }; // 100 ms
setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
```
Log and handle `EAGAIN`/`EWOULDBLOCK` returns from `sendto()`.

---

### C++ — Catch-all exception handlers discard error details
**File:** `diablo_server/services/sequencer/SequencerService.cpp:152,191,225`

```cpp
} catch (...) {
    // silent
}
```

When something throws inside the sequencer's main loops, the exception type and message are lost. The service continues running but may be in a broken state. There is no way to diagnose what failed from logs alone.

**Fix:** Catch `std::exception` explicitly and log `e.what()` before deciding whether to continue or terminate:
```cpp
} catch (const std::exception& e) {
    LOG_ERROR("SequencerService: unhandled exception: {}", e.what());
} catch (...) {
    LOG_ERROR("SequencerService: unknown exception type");
}
```

---

## Low / Housekeeping

### CMake — No AddressSanitizer or UBSan build targets
**File:** `CMakeLists.txt`

The C++ services handle UDP sockets, shared memory, and multi-threaded state. None of that is exercised under ASAN/UBSAN in CI, so memory bugs and undefined behavior go undetected until they surface as mysterious crashes in the field.

**Fix:** Add a `Sanitize` CMake preset or a `-DSANITIZE=ON` option:
```cmake
if(SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=address,undefined)
endif()
```
Run this in CI on the test suite.

---

### CMake — No compiler warning flags
**File:** `CMakeLists.txt`

Implicit conversions, signed/unsigned mismatches, unused variables, and other common bugs pass through the build silently. Enabling warnings would have caught several of the issues listed above at compile time.

**Fix:** Add to the top-level `CMakeLists.txt`:
```cmake
add_compile_options(-Wall -Wextra -Wpedantic -Wno-unused-parameter)
```
For stricter enforcement, promote specific categories to errors: `-Werror=conversion -Werror=return-type`.

---

### Integration test — Hardcoded ports with no conflict detection
**File:** `test/test_integration.sh:48-56`

Ports like `9998`, `9999`, `8081` etc. are hardcoded. If a previous run crashed and left a service holding the port, the next run silently fails to bind, and the test fails in a confusing way (service appears to start but never accepts connections).

**Fix:** Allocate ports dynamically at test startup using Python:
```bash
get_free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)"
}
SEQ_PORT=$(get_free_port)
```

---

### Integration test — Process cleanup is abrupt
**File:** `test/test_integration.sh:111-138`

The cleanup function sleeps 1 second then sends `SIGKILL`. Processes don't get a chance to flush logs, close sockets, or write final state. Leftover bound sockets from a killed process can cause the next test run to fail to bind.

**Fix:** Send `SIGTERM` first, then `wait` in a loop for up to 5 seconds, then `SIGKILL` any processes that are still running:
```bash
kill -TERM "$pid" 2>/dev/null
for i in $(seq 1 10); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
kill -KILL "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
```

---

### Backend — Config resolved path is never logged
**File:** `diablo_server/backend/src/routes/config.ts:20-38`

The config loader tries several fallback paths silently. When a deployment is misconfigured (wrong working directory, wrong symlink, stale path) there is nothing in the logs to indicate which path was tried and why they failed. The first symptom is missing sensor config or actuator roles, which is hard to trace back to a config load failure.

**Fix:** Log the resolved path at startup:
```ts
console.info(`[config] loaded from: ${resolvedPath}`);
```
And log each failed attempt at `DEBUG` level so it's visible when diagnosing issues.

---

### Sensor Info — dual ADC columns (cal + raw) for debugging

**Files:** `diablo_server/frontend/app/sensor-info/page.tsx`

Currently the Sensor Info table shows a single ADC column sourced from the calibrated entity (`*_Cal.CH*.raw_adc_counts`), which is the reliable production path. For debugging purposes it would be useful to display both:

- **Cal ADC** — `*_Cal.CH*.raw_adc_counts` (current column; always present when calibration_service is running)
- **Raw ADC** — `*.CH*.raw_adc_counts` (the raw entity stream direct from the relay, before calibration_service touches it)

Showing both side by side lets engineers confirm the raw vtable is arriving, spot firmware-side ADC glitches independently of calibration, and verify that the two values agree (they should be identical integers).

**Implementation sketch:**
- Add a second `useSensorValue(sensor.rawEntity, 'raw_adc_counts')` call alongside the existing cal one in each row component (`PtRow`, `HptRow`, `TcRow`, `RtdRow`, `LcRow`, `ActRow`).
- Add a "Raw ADC" column header next to the existing "ADC (cal)" column in each `SensorTable`.
- Render both values; show `---` when the raw entity stream is stale (it is expected to sometimes be absent — that is not a bug).
- Consider making the second column opt-in (e.g. a "debug" toggle in the page header) so the table doesn't become too wide by default.

---

### Runtime — Controller sometimes never gets service (reload UI during server startup)
**Symptoms:** The controller service / controller path appears to never receive traffic or never “comes up” from the stack’s point of view. Operators have seen this correlate with **reloading frontend tabs or hard-refreshing the browser while the backend and related services are still starting**.

**Hypothesis (unconfirmed):** A race during startup: WebSocket clients connect, subscribe, or send messages before the server has finished binding the controller TCP client, registering routes, or completing config load. Reloading the SPA may create duplicate connections, reorder handshake vs. subscription, or hit a code path that assumes a single stable client lifetime. Another angle is **ordering** between HTTP `/api/*` and WS — e.g. the UI assumes config is ready before the controller bridge is live.

**What to do when investigating:** Capture timestamps for (1) backend listen, (2) first WebSocket accept, (3) first `sendToControllerService` / controller TCP connect success, (4) frontend `getWebSocketClient` connect. Reproduce by starting the full stack and refreshing the dashboard repeatedly during the first few seconds. Compare with a run where the UI is opened only after the stack is idle.

**Fix direction (TBD):** Harden startup so the controller link is explicit in health/debug (`/api/debug` or a dedicated readiness probe); retry controller TCP with backoff; or delay accepting actuator/controller-critical WS commands until `controller` connectivity is confirmed — and document “wait for green” in dev workflows until fixed.

---

### Frontend — API response shapes typed as `any`
**Files:** `diablo_server/frontend/lib/dashboard-hooks.ts`, `diablo_server/frontend/app/config/page.tsx:661-739`

Fetch responses from `/api/config` and `/api/sensor-config` are typed as `any` or cast with `as any`. If the backend changes a field name or nests data differently, the frontend silently receives `undefined` values which propagate through the render tree as broken UI with no error.

**Fix:** Define TypeScript interfaces for every API response shape. For true runtime safety, use `zod` to parse and validate responses at the fetch boundary:
```ts
const ConfigResponse = z.object({
  config: z.object({
    actuator_roles: z.record(z.array(z.unknown())).optional(),
  }).optional(),
});
const data = ConfigResponse.parse(await res.json());
```

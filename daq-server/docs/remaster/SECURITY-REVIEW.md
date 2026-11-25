# DAQ backend security review — HTTP/WS surface and OTA path

Read-only review against `backend-remastered` (== `main` for product code). Findings are
recorded as defects for the team; nothing is fixed in the refactor. Scope: the DAQ backend's
HTTP/WS surface, the 14 operator gates, the OTA path (LEDGER D-OTA / D-FORK), the deployment
auth boundary (Caddy `forward_auth` + `auth/`), and config-writing routes.

Path legend (repo-relative under `daq-server/` unless noted):
- **A** = `diablo_server/backend/src/api-server.ts`
- **S** = `diablo_server/backend/src/server.ts`
- **O** = `diablo_server/services/ota/ota_service_main.cpp`
- **B** = `deploy/bootstrap_daq.sh`
- **C** = `../deploy/caddy/Caddyfile` (repo root `deploy/`)
- **V** = `../auth/main.py` (repo root `auth/`)

## Severity summary

| Severity | Count | Findings |
|---|---|---|
| Critical | 3 | 1 (direct :8081 = operator, opened network-wide), 2 (OTA routes ungated — D-OTA), 3 (OTA `projectPath` → RCE) |
| High | 3 | 4 (C++ control ports bind all-interfaces), 5 (WS calibration ungated), 6 (cross-site WS / CORS) |
| Medium | 4 | 7 (video routes ungated + credential exfil), 8 (`set_countdown_target` ungated), 9 (`/api/state-script/check` ungated DoS), 10 (fail-open empty-email identity) |
| Low | 2 | 11 (identity computed once, never re-checked), 12 (D-FORK: fork/exec hazard) |

**Totals: 3 Critical, 3 High, 4 Medium, 2 Low (12 findings).** Plus one refactor-specific
note (no test pins the gates) and a list of items checked that are NOT findings.

---

## Auth boundary as deployed (frames every finding)

- Caddy strips client `X-Auth-*`, then `forward_auth` copies `X-Auth-Email` / `X-Auth-User`
  from the auth service's `/verify` 200 response (C:45-61). `/verify` admits **any valid
  `@berkeley.edu` session**; the named allowlist is consulted only for `openrocket` paths
  (V:315-363; `../auth/allowlist.py:47-49`). So through Caddy, every signed-in member reaches
  the backend with a non-empty email. Operator status is then decided solely by
  `backend/operators.txt` (8 entries) via `operators.ts:49-52`.
- Backend rule, in two places: an **absent `X-Auth-Email` header ⇒ treated as operator**
  (A:345-348 `isConfigWriteAuthorized`; S:978-979 for the WS path). There is no "I am behind a
  proxy" signal anywhere in the backend (env grep of S/A shows only ports/hosts/log toggles),
  so the backend cannot distinguish "no proxy in front" from "a proxy that attached no identity".
- The 14 HTTP operator gates: A:408, 465, 582, 632, 705, 726, 756, 771, 903, 966, 1036, 1061,
  1071, 1082. HTTP gates are identity-only; WS control additionally requires `CONTROL_UNLOCK`
  arming (S:1212-1221, enforced at S:1270).
- `ota_service` has **no production systemd unit** (`deploy/systemd/install_services.sh:10-12`
  lists 12 units, none OTA); only `deploy/startup/start_tmux_dev.sh:142` starts it. The OTA
  findings are latent on a systemd stand until the service is started for a flash (which is
  exactly when it runs), and live on the dev/tmux stack.

---

## 1. CRITICAL — Direct :8081 confers operator; the deploy opens :8081 to any source

**Where:** S:978-979 (WS) and A:345-347 (HTTP) treat the no-header case as operator; the HTTP
server binds all interfaces (S:1861, `httpServer.listen(WS_PORT)` with no host). B:199-202 adds
`ufw allow 8081/tcp` and `3000/tcp` **from any source**; B:190-198 documents that this yields
full control and accepts it "for a bench network". Caddy proxies the same box (C:231,
`host.docker.internal:8081`).

**Exploit path:** on a production stand both doors are open — the gated Caddy door and the raw
:8081 door. Any host that can route to the DAQ machine (a laptop or phone on the bench network,
or a board on the 192.168.2.0/24 board LAN, since the host straddles both nets) connects to
:8081 directly. Because identity is positional (absent header ⇒ operator), that connection is an
operator with no credential. It can drive state transitions (ARM / FUEL_FILL / OX_FILL / FIRE /
VENT), open/close actuators, extend fire, and start/stop sessions.

**Stand consequence:** full engine control — moves valves, can command a fire — with the entire
Google-login / Caddy gate bypassed by network address alone.

**Severity:** Critical. **Fix:** bind the backend to loopback and require Caddy in front; or
require a positively-asserted trusted-proxy signal rather than inferring trust from an absent
header; scope the ufw rules to a management interface rather than "any source".

## 2. CRITICAL — OTA flash routes have no operator gate (confirms LEDGER D-OTA)

**Where:** `POST /api/ota-flash` (A:1169) and `POST /api/ota-flash/flash-all` (A:1101) call
neither `isConfigWriteAuthorized` nor any identity check — the only mutating routes in the chain
without one. Confirmed by direct read: every other mutating branch opens with the gate; these two
open straight into body handling. `frontend/app/flash/page.tsx:131` surfaces "Flash all boards"
in the nav for every signed-in user.

**Exploit path:** any signed-in non-operator (through Caddy) or any device on the open :8081
(finding 1) issues the POST. `flash-all` iterates every enabled board from config
(`ota-build.ts:203`) and build-flashes each. The `ip` field is caller-supplied, so any reachable
`host:3232` can be targeted; `firmwareBase64` is unverified bytes (O:129-155 checks only size
≤ 2 MB).

**Stand consequence:** a non-operator reflashes one or every board. A board can be left running
attacker-chosen or broken firmware going into a test — valve-driving hardware with unknown logic.

**Severity:** Critical. **D-OTA confirmed.** **Fix:** add the operator gate to both routes.

## 3. CRITICAL — OTA `projectPath` build → arbitrary code execution as the service user

**Where:** A:1200-1206 accepts a caller-supplied `projectPath`, joins it under the workspace root
when relative (no `..` containment check) or honors it outright when absolute, and passes it to
`ota_service`, which `chdir`s into it and runs `pio run` (O:232-243). PlatformIO executes
`extra_scripts` Python from the project's `platformio.ini`; the real firmware inis already use
this (`firmware/Hotfire_Code/Actuator_Hotfire/platformio.ini:14`).

**Exploit path:** reachable through the ungated route (findings 1-2). Pointing the build at any
directory that contains a crafted `platformio.ini` causes `pio run` to execute arbitrary Python
in that ini as the `ota_service` user.

**Stand consequence:** full compromise of the stand host (not just a board), from the same
unauthenticated position as finding 1.

**Severity:** Critical. **Fix:** gate the route (finding 2); constrain `projectPath` to a vetted
allowlist of in-repo firmware project directories; reject absolute paths and `..`.

## 4. HIGH — Sequencer :9998, controller :9999, ota_service :9997 bind all interfaces, no auth

**Where:** `services/sequencer/sequencer_main.cpp:264`, `services/controller/controller_main.cpp:139`,
and O:422 all bind `INADDR_ANY`. The sequencer accepts `TRANSITION:` / `ACTUATOR:` / `EXTEND_FIRE`
(sequencer_main.cpp:83, 121, 160); the controller accepts `FIRE_START` / `FIRE_STOP`; ota_service
accepts build/flash. `operators.ts:6-7` claims the gate "cannot be bypassed by talking to the
backend directly" — these ports are that bypass, one layer below the backend.

**Exploit path:** exposure depends on ufw being active with default-deny. B opens only
3000/8081/video and treats ufw-inactive as a normal path (B:213). With ufw off, any LAN device
connects to these ports and sends raw control lines, driving the engine directly.

**Stand consequence:** engine control (transition, actuator, fire) and board reflash by any LAN
device when the host firewall is not up.

**Severity:** High. **Fix:** bind these command/control ports to loopback — they are only ever
addressed as 127.0.0.1 (S:1420, S:1452; `ota-service-cmd.ts:7`).

## 5. HIGH — WS `CALIBRATION_COMMAND` has no operator/arm gate

**Where:** S:1225 dispatches `CALIBRATION_COMMAND` to `handleCalibrationCommand` with no
`__daqOperator` / `__daqControlAuthorized` check. `CONTROL_COMMAND_TYPES` (S:64) governs only
`SEND_COMMAND` subtypes, not this top-level message type.

**Exploit path:** any signed-in user (through Caddy) or any direct-:8081 client sends
`CALIBRATION_COMMAND` with types `clear_calibration`, `zero_all`, `tare_lc`,
`capture_reference`, or `save_coefficients` (calibration-handler.ts:143, 404, 329, 230, 343),
which publish `[0x46,0x00]` packets to the live calibration service and write JSON files
(calibration-handler.ts:384).

**Stand consequence:** directly answers "corrupt calibration?" — yes, mid-test, by a
non-operator. Sensor readings (pressures, load cells) can be silently invalidated during a run.

**Severity:** High. **Fix:** gate `CALIBRATION_COMMAND` behind the same operator/arm check as the
engine-control commands.

## 6. HIGH — Cross-site WebSocket / `Access-Control-Allow-Origin: *` on the direct port

**Where:** `new WebSocketServer({ server: httpServer })` (S:901) sets no `verifyClient` / origin
check, and the ws 8.x default `maxPayload` (100 MiB) is left in place. A:376 sets
`Access-Control-Allow-Origin: *`.

**Exploit path:** a bench laptop that merely views a hostile web page has that page open a socket
to the stand's `ws://<host>:8081`; the handshake returns `operator:true`, and the page can arm
and issue control/calibration commands — no credential, because identity is positional
(finding 1). Through Caddy this is blunted by the `SameSite=Lax` session cookie (V:218-229), but
that protection does not exist on the direct :8081 door the deploy opens.

**Stand consequence:** engine/calibration control triggered by a victim operator's browser
visiting an unrelated page while on the stand network.

**Severity:** High. **Fix:** enforce an origin allowlist on the WS upgrade and scope CORS;
combine with finding 1 (loopback bind).

## 7. MEDIUM — Video routes entirely ungated, including a credential-exfiltration vector

**Where:** `handleVideoRequest` (`video/routes.ts:77`) applies no operator check to any method.
`PUT /api/video/config` (routes.ts:103) writes gateway/stream secrets; `record/start` /
`record/stop` (routes.ts:126, 130) can stop recording during a test; `POST /api/video/previews`
(routes.ts:144 → `video/service.ts:192-202`) takes a caller `url` plus an existing
`fromStreamId`, and `withCredentials` (service.ts:202) makes the gateway open an RTSP connection
to that URL using the saved camera password.

**Exploit path:** a non-operator supplies an attacker-controlled RTSP `url` and a real
`fromStreamId`; the gateway dials the attacker's server and presents the stored camera
credential.

**Stand consequence:** loss of the test video record (evidence), config tampering, and
exfiltration of stored camera credentials to an attacker endpoint.

**Severity:** Medium (High for the credential path). **Fix:** gate video mutations behind the
operator check; for previews, reuse a saved credential only with its saved URL, never a
caller-supplied one.

## 8. MEDIUM — `set_countdown_target` is an ungated control action

**Where:** S:1360. `set_countdown_target` is a `SEND_COMMAND` subtype absent from
`CONTROL_COMMAND_TYPES` (S:64), so it skips the arm gate at S:1270.

**Exploit path:** any WS client sets or clears the countdown target; it is persisted to disk
(`countdown-state.ts:39`) and broadcast to all clients.

**Stand consequence:** a non-operator disrupts the countdown every operator sees. No valve
motion, but a real operational-integrity problem during a count.

**Severity:** Medium. **Fix:** add it to `CONTROL_COMMAND_TYPES` or gate it explicitly.

## 9. MEDIUM — `/api/state-script/check` is ungated, unbounded, and spawns a process per call

**Where:** A:669. No operator gate; the body is accumulated with no size cap (A:671-672, unlike
the OTA 4 MB cap); each call writes a temp file and `execFile`s `state_script_check` with a 5 s
timeout (`routes/script-check.ts:76-88`).

**Exploit path:** a non-operator issues many concurrent large requests, spawning processes and
consuming CPU/disk.

**Stand consequence:** denial of service against the stand host during a live test window.

**Severity:** Medium. **Fix:** gate it, cap the body size, and bound concurrency.

## 10. MEDIUM — Fail-open identity: a valid session with an empty email claim becomes operator

**Where:** `/verify` sets `X-Auth-Email` from `claims.get("email","")` (V:356). A valid JWT whose
`email` claim is empty produces an empty header, which the backend reads as operator (the
finding-1 rule). `may_use_app` / `may_sign_in` key on domain suffix (V:99-114), so this depends on
whether a session can ever verify with a blank email.

**Exploit path:** any path that yields a verified session with no/empty email claim
(mint/claim-shape invariants live in `auth/shared_auth.py`, not fully in scope) turns into a
backend operator.

**Stand consequence:** operator control from a session that carries no identifiable user.

**Severity:** Medium. **Fix:** in the backend, treat an empty `X-Auth-Email` as
unauthenticated-not-operator whenever any `X-Auth-*` header is present; have `/verify` refuse to
emit an allow with an empty email.

## 11. LOW — Identity is computed once at upgrade and never re-checked

**Where:** S:978-980 fixes `__daqOperator` at connect; `__daqControlAuthorized` (S:1217) never
expires. `operators.txt` is re-read by mtime, but only for new sockets.

**Exploit path:** a long-lived socket stays armed for the whole session regardless of cookie
expiry or an operator being removed from the roster.

**Stand consequence:** a revoked or expired operator retains live control until they disconnect.

**Severity:** Low. **Fix:** re-evaluate operator status on a timer or per control command; expire
the arm.

## 12. LOW — D-FORK confirmed: non-async-signal-safe work between fork and exec in a threaded process

**Where:** O:237-238 does `std::to_string` (heap allocation) and `setenv` after `fork()` while
other detached client threads run (O:451). If another thread holds the malloc/env lock at fork,
the child can deadlock before `execlp`. Because threads are detached and the parent `waitpid`s
(O:259), a stuck child hangs the handler and leaks `client_fd`. Combined with thread-per-connection,
a 15-minute build timeout (`ota-service-cmd.ts:14`), and no connection cap, repeated OTA calls can
exhaust the host.

**Stand consequence:** reliability / denial of service of the OTA service (and, via leaked fds,
the host) under repeated flashing.

**Severity:** Low. **Fix:** build the env string and flags before forking; prefer `posix_spawn`
or a pre-forked helper. Matches ledger D-FORK.

---

## Refactor-specific note (not a product defect)

Nothing in `diablo_server/backend/src/__tests__/` asserts any HTTP 403 or the OTA gate state — a
grep for "Not an approved operator" across the tests returns zero, and `operators.test.ts` only
unit-tests `isOperator`. The 14 HTTP gates and the WS control gate are therefore unpinned by
backend tests. The characterization goldens `test/characterization/lifecycle/golden/ota.txt` and
`pipeline/golden/http.txt` capture the ungated OTA behavior as the frozen contract, so an
accidentally-dropped gate on another route could pass green. **Recommendation for the refactor:**
add a test that a non-operator email is refused on a representative mutating route, so a dropped
gate goes red.

## Checked and NOT findings (examined, no issue)

- Profile / CSV / script names are allowlisted: `routes/config-profiles.ts:26, 302, 341`;
  `routes/calibration-profiles.ts:22`. No path traversal via names.
- Static GUI blocks traversal and non-dist escape: `static-gui.ts:53-55`.
- Caddy strips client-supplied `X-Auth-*` ahead of the gate (C:46-52, route-wrapped so ordering
  holds), and `deploy/caddy/tests/check_gate_order.py` covers the daq host; the daq site is not
  in PUBLIC_HOSTS.
- Config import/save roll back on invalid TOML and validate PWM actuators (A:481-487) — the risk
  there is the missing network boundary (findings 1-2), not parsing.
- Video config refuses credentials embedded in URLs and never returns stored passwords
  (`video/config.ts:7, 323-327`) — the exfil vector in finding 7 is the preview path, not config
  readback.

## D-OTA verdict

**Confirmed.** A:1101 and A:1169 have no operator gate; this is a genuine, currently-exploitable
authorization gap whenever `ota_service` is running, and findings 2-3 make it the most dangerous
route in the surface (board reflash plus host RCE). Its blast radius is larger than the ledger
line states.

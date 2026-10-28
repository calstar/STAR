# Plan: motorized ball valve board in daq-server

## Status (2026-10-28): built

All seven phases below are in. Where the build departs from the plan:

- **No CLOSE-in-abort warning.** Every validation issue gates session start, and a ball valve
  that should close in an abort is a legitimate config, so the warning would fire on correct
  configs. The ball valve rules are errors only: NO, or a PWM assignment, on a ball valve role.
- **Thresholds are constants, not config fields:** open >= 95 %, closed <= 5 %
  (`backend/src/ball-valve.ts`).
- **No role in any profile, and the board stays disabled everywhere** — including
  `config_base.toml`, which the integration test runs from. Enabling it is: `enabled = true`, a
  role such as `"Main Ball Valve" = ["NC", 1, 71]`, and a row in both state CSVs.
- **config_broadcast's abort-list filter has no unit test** (`buildPackets` reads files); the
  `ball_valve` flag it reads is covered by `lib/test/test_ball_valve_config.cpp`.
- **The simulator** gates CLOSE on heartbeats only once one has been heard, so a loopback sim
  stack that never delivers the broadcast heartbeat can still close it.

Firmware: `firmware/Hotfire_Code/BallValve_Hotfire` (board 71). One valve per
board today, a second later.

| Direction | Packet | Meaning |
|---|---|---|
| server → board | `ACTUATOR_COMMAND` actuator 1 | 1 = open (20 mA), 0 = closed |
| server → board | `ACTUATOR_CONFIG` | only the log-mode byte is read |
| server → board | `SERVER_HEARTBEAT` | board is Active while current; after 5 s without one it **opens the valve** and ignores CLOSE until heartbeats return |
| board → server | `BOARD_HEARTBEAT` | |
| board → server | `SENSOR_DATA` sensor 1 | position, raw 12-bit counts: V = counts/4095·3.3, mA = V·10, % open = (mA−4)/16·100 |

Goal: the valve is configured as a board plus an actuator role, appears as an
actuator everywhere actuators appear, shows **% open when commanded open and %
closed when commanded closed** instead of current, takes part in state
transitions and is scriptable like any other actuator. NO/NC does not apply.

## What already works, unchanged

Actuators are driven by `[actuator_roles]` (`"Name" = [kind, channel, board_id]`)
and there is no type filter downstream, so a role on board 71 is already:

- commanded per state from `state_machine_actuators.csv` / `_delays.csv`
  (`ActuatorCommander.cpp:80-107` resolves board 71's IP from `[boards.*]`);
- scriptable: every role becomes a slug for `open_valve()` / `close_valve()`
  (`lib/src/script/ScriptConfig.cpp:38-56`, `frontend/app/config/page.tsx:1600`);
- commandable from the GUI and over `ACTUATOR:<name>:<0|1>` on :9998;
- listed on the dashboards (`useActuatorsFromConfig` reads `[actuator_roles]`);
- given a DHCP reservation once its `[boards.*]` entry has `ip` and `mac`.

NC is already a pass-through on the wire (`is_no ? 1-pos : pos`), so the
valve's command path needs no polarity code; the work is to stop anyone
configuring it as NO.

## Decisions (recommendations in bold)

1. **A new board type, `BALL_VALVE`**, rather than reusing `ACTUATOR`. Reusing
   it would put position data through the current-sense path (0x30 → 0x31
   `current_a`), offer NO/NC, and alias with actuator board 11 (below).
2. **Its own Elodin namespace.** Every layer derives the slot as
   `board_id % 10`, so board 71 is slot 1. That is actuator board 11's slot, and
   `[0x32] ACT_CMD.B1.CH1` has no type byte, so the commanded state would collide
   whatever the board type. Use free high bytes:
   - `0x33` raw: `BV{slot}.CH{ch}`, `raw_adc_counts`
   - `0x34` calibrated: `BV{slot}_Cal.CH{ch}`, `position_pct` (+ `current_ma`, `raw_adc`, `status`)
   - `0x35` commanded: `BV_CMD.B{slot}.CH{ch}`, `actuator_state_commanded`

   With that, board 71 can keep its ID.
3. **Leave the valve out of the abort list sent to actuator boards.** Today
   config_broadcast puts every role into every actuator board's `ACTUATOR_CONFIG`,
   so the designated survivor would command this valve in a no-connection abort.
   The valve board will have lost the server too, so it will already be opening
   itself and ignoring CLOSE. Its own failsafe is the abort behaviour. Add a
   validation warning when a ball valve's `Vent` / `Engine Abort` / abort-state
   cells say CLOSE, since the board will open on loss of comms regardless.
4. **The sensed state feeds the mismatch check.** % open ≥ 95 counts as open,
   ≤ 5 as closed, anything between as travelling (not counted). Mismatch fires
   only if it is still wrong after the existing 5 s delay. Thresholds are config
   fields. This would be the first real producer of `actuatorSensedState`:
   nothing publishes it today, so the mismatch check has never fired.
5. **Keep the role tuple format** (`["NC", 1, 71]`) so every existing parser
   keeps working. NO/NC is hidden in the UI for ball-valve boards, written as
   `"NC"`, rejected as `"NO"` by validation, and forced pass-through in C++.

## Work, in order

Each phase lands with its tests green (`ctest`, `npm test`, `npm run lint`, all
hermetic). Nothing here needs the live stand.

### 1. Board type and config

- `lib/include/config/LoadActiveBoards.hpp:14` add `ActiveBoardKind::BALL_VALVE`;
  `lib/src/config/Config.cpp:28-44` `kind_of()` maps `"BALL_VALVE"`.
- `lib/include/fsw/BoardTypeWire.hpp` wire type 8; `daq_bridge_main.cpp:187-203,
  233-273` both directions.
- `Config.cpp:196-209`: a role whose board is `BALL_VALVE` gets `is_no = false`
  whatever its kind (defensive; validation rejects `NO` first).
- `shared/config-validation.ts`: `BOARD_TYPE_LABEL` (99-102) `'Ball Valve'`; skip
  sensor-role checks for it like `ACTUATOR` (200-201); error on a `NO` role on
  a ball-valve board; warn on CLOSE in abort columns (decision 3); rebuild the
  `.js` / `.d.ts`.
- Config profiles `default`, `server`, `digital-twin`: a `[boards.ball_valve_board]`
  entry (`type = "BALL_VALVE"`, `board_id = 71`, `ip = "192.168.2.71"`,
  `active_connectors = [1]`, `listen_port = 5005`, `mac = ""` until read off the
  serial log). `enabled = false` in default/server until the hardware is on the
  stand; digital-twin gets an enabled board and a role for tests.
- `docs/CONFIGURATION_GUIDE.md`, `config/README.md` board registry.

### 2. Configuration pages (`frontend/app/config/page.tsx`)

- Boards editor: add `BALL_VALVE` to the type select (2402-2408); summary
  "N valve" (2321); show designated-survivor only for `ACTUATOR` (2554).
- Actuator Roles editor (3019-3127): when the row's board is `BALL_VALVE`, hide
  the NO/NC select and store `"NC"`; hide PWM assignment (a ball valve is never
  a PWM output, and a 4th element would skip it in Fire).
- `frontend/app/boards/page.tsx:89` add to `TYPE_ORDER`; decide self-test N/A
  (171): the board sends no SELF_TEST, so N/A like ENVIRONMENTAL.

### 3. Data path: daq_bridge → calibration → Elodin

- `daq_bridge_main.cpp`: route `BALL_VALVE` SENSOR_DATA to `0x33` (919-952);
  exclude it from the proactive SENSOR_CONFIG heartbeat (495-498); its own
  vector into `register_tables` / `register_calibrated_tables` (548-574);
  stats tag (996-1017).
- `lib/src/elodin/DatabaseConfig.cpp`: raw `BV{slot}.CH{ch}` on 0x33, calibrated
  `BV{slot}_Cal.CH{ch}` on 0x34, commanded `BV_CMD.B{slot}.CH{ch}` on 0x35,
  subscribe lists (175-198).
- Calibration service: accept 0x33 (1640-1652); convert with a new
  `fsw::calibration::valve_position` in lib (counts → mA → % open, clamped to
  0-100, status flag for < 3.5 mA = open loop / no signal) so it is unit-
  testable; publish on 0x34 with a new `CalibratedValvePositionMessage`
  (`transport/.../CalibratedSensorMessages.hpp`).
- `services/config_broadcast`: send `BALL_VALVE` boards `ACTUATOR_CONFIG` with
  `is_abort_controller = 0` (416-429); drop ball-valve roles from the abort list
  (338-347).

### 4. Sequencer

- `ActuatorCommander`: carry the board kind on each role; publish commanded
  state on 0x35 for ball valves (32-39 and its callers).
- `SequencerService.cpp:580-585`: register the 0x35 tables for `BALL_VALVE`.
- Nothing else: the CSV, delays, manual override, scripts and TCP `ACTUATOR:`
  path are type-agnostic.

### 5. Backend

- `elodin-client.ts:194` allow 0x33-0x35; `server.ts:110` route them to the GUI.
- `elodin-protocol.ts`: decode 0x33 `raw_adc_counts`, 0x34 `position_pct` /
  `current_ma`, 0x35 `actuator_state_commanded`.
- `elodin-vtable-registry.ts:240-289`: subscribe `BALL_VALVE` boards.
- `server.ts:496-511`: heartbeat wire 8 → `'BALL_VALVE'`.
- `legacy/state-actuators.ts:100-136`: resolve a ball-valve role to `BV_CMD.*` /
  `BV*` entities.
- Mismatch (decision 4): feed `actuatorSensedState` from `position_pct` with the
  thresholds; extract `checkActuatorMismatch` out of `server.ts` so it can be
  tested.
- `ota-build.ts:186-192`: `BALL_VALVE: 'firmware/Hotfire_Code/BallValve_Hotfire'`.
- `api-server.ts` per-type counts; `board-scan-rate.ts` group.

### 6. Frontend display

- Actuator lists (`lib/dashboard-hooks.ts`, `lib/actuators-from-config.ts`):
  carry the board type with each entry.
- `lib/store.ts:147, 248-272`: aliases to `BV*` entities for ball-valve roles;
  add `position_pct` to the actuator components.
- `components/controls/ActuatorControlByName.tsx`: a position mode. Under the
  tile, instead of `x.xx A`:
  - commanded OPEN → `NN% OPEN`
  - commanded CLOSED → `NN% CLOSED` (100 − % open)
  - no position data → `--- %`; open-loop status → `NO SIGNAL`
- Callers: `UnifiedDashboard`, `IpadDashboard`, `MobileDashboard`.
- `components/plots/ActuatorStatePanel.tsx`, `app/status/page.tsx`: show the %
  next to the commanded state for ball valves.
- `app/sensor-info/page.tsx` + `lib/sensor-info-entities.ts`: a "Ball valves"
  table (counts, mA, % open).
- `app/plots/solenoid-characterization`: exclude ball valves from the PWM
  dropdown.

### 7. Simulator, post-processing, docs

- `sim/board_simulator.py`: a `BALL_VALVE` board that answers commands with a
  ramp in position (a few seconds of travel) and opens itself on heartbeat
  loss, so the digital twin and the e2e harness exercise all of the above.
- `tools/postprocessing`: `webviewer/backend/naming.py` (`position_pct` → `%`),
  `run_config.py` labels, `analyze_run.py` must not read a % series as a 0/1
  state (446-467), plot % open beside the commanded state.
- `procedures/actcomm.md`: NO/NC check does not apply to ball valves; verify
  % open tracks the command and that the valve opens on loss of comms.
- `docs/ACTUATOR_PIPELINE_AND_TMUX.md`.

## Tests

| Where | What |
|---|---|
| `lib/test` | `kind_of("BALL_VALVE")`; role on a ball-valve board is pass-through even if written `NO`; `valve_position` (4 mA → 0 %, 12 → 50 %, 20 → 100 %, clamping, < 3.5 mA flag); `DatabaseConfig` registers `BV*` on 0x33-0x35 and nothing on 0x30-0x32 for board 71; config_broadcast excludes ball-valve roles from abort lists and sends the board `ACTUATOR_CONFIG` with `is_abort = 0`; `ActuatorCommander` publishes a ball valve's commanded state on 0x35 |
| `test_script_positions.cpp` | a scripted `open_valve(BALL_VALVE)` emits state 1 to 192.168.2.71 actuator 1 |
| backend `__tests__` | `elodin-protocol` decodes 0x33/0x34/0x35; `vtable-subscriptions` with board 71 next to board 11 (no shared keys); mismatch thresholds (open / closed / travelling) |
| frontend `__tests__` | config validation (NO rejected, CLOSE-in-abort warning, slot check); roles editor hides NO/NC; `ActuatorControlByName` shows `% OPEN` / `% CLOSED` per commanded state; sensor-info rows |
| post-processing | `naming`, `run_config` labels for `BV*` |

Each new test is checked against its bug: break the thing it guards and
confirm it goes red.

## Open questions for the team

- The valve's role name, and its OPEN/CLOSE cell in each state of the
  state-machine CSVs (the plan adds no role to the production profiles until
  that is decided).
- Whether the % OPEN / % CLOSED thresholds (95 / 5) are right for this valve.
- The board's MAC, for the DHCP reservation.

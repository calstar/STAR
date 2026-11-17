# pipeline/ golden audit (D20)

Every line that `char/pipeline-boards` removes from the pipeline goldens relative to
`backend-remastered`:

```bash
git diff backend-remastered...char/pipeline-boards -- 'daq-server/test/characterization/pipeline/golden/*' | grep '^-[^-]'
```

That is 152 lines (6 fewer than the 158 first counted: the `session-timeout-*` replay lines are
restored, see row 7). For each line or group: what covers it now, or why it is dropped. Rule ids
refer to `README.md`.

| # | removed (file) | n | covered by / dropped |
|---|---|---|---|
| 1 | `SELF_TEST.BOARD_21.sensor_N  rate=event(<0.25/s)  value=1`, N = 0..10 (ws_streams.txt) | 11 | **Covered, exact when idle.** The new line `board 21 (PT): sensor_0, sensor_1, sensor_10, sensor_2, …, sensor_9 all 1 \| not-received (…)` names every sensor and value. The P12 rule line enforces it: (a) any received result must be exactly that set, all 1; (c) in a quiet run board 21 must be received. The rate class is dropped per P2 (no observed rates; bound T1 instead). Proof: the `selftest_drop` mutation (backend drops every SELF_TEST row) goes red idle on pt and boards, and under 1× load on boards. |
| 2 | `  SELF_TEST.BOARD_21.sensor_N {1}` in three history replies: `# connect client A`, `# history client A`, `# viewer_client client B` (ws_streams.txt) | 33 | **Covered, exact when idle.** P12 rule (d) checks each of these paths separately (`paths checked: … history connect A; history history A; history viewer_client B`). In a quiet run each must carry board 21's full set, all 1 (rule (a) per path, rule (d) completeness). |
| 3 | handshake self-test replay: 11 `SELF_TEST.BOARD_21 sensor_N value 1` frames for client A and 11 for client B (ws_handshake.txt) | 22 | **Covered, exact when idle.** Each replay is now the marker `<self-test replay: see ws_streams.txt self-test section (P12)>` at the same place in the burst. P12 checks each client's replay as its own path (`handshake A`, `handshake B`, plus the new `handshake C`). In a quiet run each replay must hold every expected sensor, value 1. The order inside the replay is not frozen (P10: arrival order across boards is a race). With every SELF_TEST row dropped, the markers disappear and the rule line goes red. |
| 4 | every other `… rate=stream(0.25-5/s)  value=V` / `rate=event(…)` line: PT1 raw and cal ×40, ACT_CMD B2 ×7 and B4 ×9, CONTROLLER.state ×3 (ws_streams.txt) | 59 | **Covered.** The same line without its rate class (`… value=V`) is still in the file with the same value. The one exception is the live Fuel Main line `ACT_CMD.B2.CH7 … value=0`, now alternative A1 (row 14). The rate classes are dropped per P2: delivery rates depend on load. T1 (envelope spacing bound) replaces them, and the `gui_rate` mutation goes red under load. |
| 5 | `connection_status / board_status_update / board_log  rate=stream(0.25-5/s)` (ws_streams.txt) | 3 | **Dropped (P2):** observed delivery rates. Their payloads are still frozen in the "distinct payloads" sections. |
| 6 | headers `## sensor_update (… P2 rate per stream, P7 values)` and `## periodic types (… P2)` (ws_streams.txt) | 2 | **Covered** by `## sensor_update (client A, whole session; P7 values)`. The periodic-types section went with row 5. |
| 7 | `session-timeout-300000` / `-60000` notifications in client B's handshake replay (ws_handshake.txt) | 0 | **Restored.** Client B now connects early, inside the backfill horizon (the move that removed them; see row 12). A new client C connects after the session and receives the same notification-buffer replay. The six lines are back in `## client C`, so they are no longer in the diff. |
| 8 | `## board-health notifications seen (any step, any client; P1)` (ws_events.txt) | 1 | **Covered** by the same section, renamed `… (P1, reset flaps P1b)`. |
| 9 | `{"key": "board_lost_21", … "ongoing": true}` and `… "ongoing": false}` (ws_events.txt, board-health section) | 2 | **Dropped (P1b):** a reset flap. Session start/stop reloads board status from config, and whether the next 1 Hz sweep beats board 21's next 1 Hz heartbeat decides if a board that never stopped is called lost. A board that really stops is still recorded (board 60 in `golden/boards`). The defect is listed in the README. |
| 10 | `-## viewer_client` plus its 4 lines (`> B control_unlock`, `> B state_transition`, `< B not_operator`, `< B Control locked`) (ws_events.txt) | 5 | **Covered (moved).** The same five lines now appear earlier in the file (`+## viewer_client` after `## live`), byte-identical. |
| 11 | `calibrationFilePath: "<daq>/calibration/calibration_2026-02-25T03-44-09.json"` (ws_events.txt) | 1 | **Covered:** `calibrationFilePath: "<fx>/srv/calibration/calibration_2026-02-25T03-44-09.json"`. It is the same file name; the fixture now owns the directory because the old value came from checkout mtimes ("Platform neutrality"). The file-absent case is frozen as `null` in `golden/nocal`. |
| 12 | history `# viewer_client client B: 70 series`, with `ACT_CMD.B2.CH2 {0, 1}`, `ACT_CMD.B2.CH8 {0, 1}`, `CONTROLLER.state.{from_state,reason,to_state}` (ws_streams.txt) | 6 | **Partly covered, partly dropped.** B moved from ~60 s to ~10 s into the run: at 60 s the one-shot self-test fell outside the backend's 60 s connect-backfill horizon on slower machines. 70 = 56 + 11 self-test (row 2) + 3 CONTROLLER. Its values now read `CH2 {0}`, `CH8 {1}` (the state before the transitions), and the CONTROLLER.state series does not exist yet. The late values are still frozen live: A's lines `ACT_CMD.B2.CH2 value={0, 1}`, `CH8 value={0, 1}` and `CONTROLLER.state.* value={1, 2} / 0`. **Dropped:** the history-path copy of the after-transition state. A client late enough to see it (C) is past the 60 s horizon, so its backfill is not frozen (`selftest_paths` docstring). |
| 13 | `# connect client A: 67 series`, `# history client A: 67 series` (ws_streams.txt) | 2 | **Covered:** `…: 56 series (self-test: P12)`. 67 = 56 + 11 self-test series, which move to P12 (row 2). |
| 14 | `  ACT_CMD.B2.CH7.actuator_state_commanded {0}` in three history replies (ws_streams.txt) | 3 | **Covered by alternative A1:** `{0} \| {0, 1}  # alternative A1: …`. Exactly `{0}` or `{0, 1}`; any other value set prints as observed and fails. The `{0, 1}` case is the sequencer's boot-time de-energized row, which elodin-db replays on subscribe under load (defect). |
| 15 | cubic store `body: sha256=e867… keys=[…]` (http.txt) | 1 | **Covered:** the full normalised body. It is now the fixture's store (seeded by calibration_service from `cubic_calibration.default.json`), not the checkout's tracked file. Its epoch-second stamps are masked per N1s. |
| 16 | OTA `body: {"projects": [Actuator_Hotfire, BallValve_Hotfire, …]}` (http.txt) | 1 | **Covered:** `{"projects": [LC_Hotfire (Group/), PT_Hotfire]}` from the fixture's fixed `firmware/Hotfire_Code`. It exercises the same discovery rules: nesting, the `Hotfire_Tests` exclusion, `.pio` skipped. **Dropped:** the repo's actual project list. It came from the checkout, changes with every firmware project, and was absent from partial exports. |

Total removed: 11 + 33 + 22 + 59 + 3 + 2 + 1 + 2 + 5 + 1 + 6 + 2 + 3 + 1 + 1 = 152.

## char/pipeline-slot10 (D41 harness fix + the stalesub session)

```bash
git diff backend-remastered...char/pipeline-slot10 -- 'daq-server/test/characterization/pipeline/golden/*' | grep '^-[^-]'
```

Zero lines removed, zero modified. `golden/`, `golden/boards/` and `golden/nocal/` are byte-identical
to `backend-remastered`; the branch only adds `golden/stalesub/stalesub.txt` (the D-SUB case, README
"The stalesub session"). Board 60 stays in the boards fixture, so every line that freezes D-SLOT
(`boards/http.txt` validator slot-10 error, `boards/ws_events.txt` setup-stuck / lost / connected,
`boards/ws_streams.txt` board 60 self-test) is untouched.

## char/c0-h8 (H8: the viewer's operator gates)

```bash
git diff queue/T...char/c0-h8 -- 'daq-server/test/characterization/pipeline/golden/*' | grep '^-[^-]'
```

Zero lines removed, zero modified. The branch only adds the `http_viewer_gates` step: a new
section in `golden/http.txt` (eight viewer 403s and five witness GETs, README "Operator gates as
the viewer") and its empty header in `golden/ws_events.txt`. The six viewer 403s already in
`http_errors`, and client B's WS lines (`ws_handshake.txt` `control_status`, `ws_events.txt`
`viewer_client`), are untouched.

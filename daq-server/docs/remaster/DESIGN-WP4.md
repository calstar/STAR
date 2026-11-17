# DESIGN-WP4 — dead launchers, broken and superseded test scripts, the `--legacy` branch

The "as decided" execution note for WP4: what an implementer deletes or edits, in what order, with
the repo-wide evidence for each file. Scope: BLOAT-MAP §2d, §6 and the WP4 row; LEDGER WP4 row
(H-1 done; the reviewer's alias item, §5); D42(e)/D49 (`test_duplicate_subscription.ts` is parked);
WP2-EVIDENCE.md (the `send_fake_pt` scripts, the two `test_integration.sh` fossil comments);
WP1-EVIDENCE.md §1 (`test_ota_flash.py:57`). No product code changes: nothing here is launched by
a systemd unit, `dev.sh`, CI or the gate, so the frozen contract (D5) is untouched by construction
and the oracle (`test_integration.sh`) loses only a branch that has not been runnable.

**Baseline.** Every line number is `git show backend-remastered:daq-server/<path>` at
`backend-remastered` @ **`d20852e9`**. Under `deploy/`, `sim/`, `archive/`, `tools/` and `test/`
(outside `test/characterization/`) that tree equals `main` @ `15b5a0c5` except two files:
`test/test_integration.sh` (H1 `f47aa8e3`, H2 `07cecad5`/`9d029561`) and `test/ws_data_flow_test.ts`
(H2). BLOAT-MAP's `test_integration.sh:21,42,824-837` is therefore stale: at the tip the flag arm
is 42, the usage lines are 19 and 21, the dead `else` branch is 843-857 and the stale comment is
762-763. Re-anchor with `grep -n 'if \[ "\$BACKEND" = "thin" \]\|--legacy\|TEST_RELAY_WS_PORT'`.
WP1 and WP2 land first (Phase 3 order WP1 → WP2 → WP4): `build-ci/` and
`transport/test/send_fake_pt.cpp` are already gone when WP4 is cut, and WP2 has deleted
`archive/README.md` (checked on `wp/WP2-dead-cpp`: `archive/` keeps only `legacy/python-services/*`
and `legacy/utl/db.hpp`).

**Method (every file below).** `git grep -n -I -F -e <stem> backend-remastered -- . ':!daq-server/node_modules'
':!daq-server/.cache' ':!daq-server/diablo_server/backend/dist' ':!daq-server/docs/remaster'`,
over the **whole repo** (root `scripts/`, `setup.sh`, `format.sh`, `.github/workflows/*`,
`SETUP.md`, `docker-compose.yml`, `deploy/systemd/*.service`, `dev.sh`, every README). Hits in the
file itself and in other files this note deletes are omitted from the tables. Read-only: nothing
was built or run; the dry run in §4.1 is `sed` on an extracted copy.

**Rules applied:** AGENT-RULES 2-3, 6, 10; D5, D17 (defects stay), D19 (full gate + Linux leg: the
oracle is edited), D25, D42(e), D49; STYLE-S15, S35, S38, S39.

---

## 1. What WP4 deletes

### 1.1 Launchers (`deploy/startup/`, `sim/`)

Every launcher below starts the Elodin relay (`npm run relay`), the Python calibration sidecar
(`tools/calibration/calibration_server.py`, which cannot import — BLOAT-MAP defect 1) or
`src/server-legacy.ts` (not in the tree: `git ls-files diablo_server/backend/src/server-legacy.ts`
is empty), and passes `--relay-host/--relay-port` that `calibration_main.cpp:603-613` does not parse.

| file | lines | what it launches | references outside the deleted set |
|---|---|---|---|
| `deploy/startup/start_tmux_dev_legacy.sh` | 236 | `:2` "DEPRECATED"; `:148` `npm run relay`; `:155` `npx tsx watch src/server-legacy.ts`; `:161` `--relay-host 127.0.0.1 --relay-port 9091`; `:162` the sidecar; `:163` `sim/setup_sim_network.sh`; `:175` `data_logger_service.py`; tmux session `sensor-dev` (`:11`, same name as the live launcher) | `start_tmux_dev.sh:3` (comment, §2.4); `docs/ACTUATOR_PIPELINE_AND_TMUX.md:7,27` (WP12) |
| `deploy/startup/start_web_gui.sh` | 180 | `:89` `npm run relay`; `:102` backend "data via relay"; `:127` `sim/setup_sim_network.sh`; `:149` `--relay-host … --relay-port 9091` | `scripts/README.md:24`, `docs/ACTUATOR_PIPELINE_AND_TMUX.md:28` (WP12) |
| `deploy/startup/start_calibration_stack.sh` | 127 | `:6` calls the sidecar "dormant"; `:72` `npm run relay`; `:89` `--relay-host`; `:93,98` sidecar; `:106` `calibration_orchestrator_gui.py`; `:120` names `./scripts/startup/stop_calibration_stack.sh` (wrong path); tmux session `calibration_stack` | `scripts/README.md:24`, `tools/gui/README.md:60,160` (WP12) |
| `deploy/startup/stop_calibration_stack.sh` | 34 | pkills the sidecar, relay, daq_bridge, elodin-db by name (`:17,19,26`) | none (only `start_calibration_stack.sh:120`, deleted) |
| `deploy/startup/start_fake_data_stack.sh` | 139 | `:58` `npm run relay`; `:82-83` `sim/setup_sim_network.sh`; `:94` `ELODIN_RELAY_WS_URL=… USE_DIRECT_DAQ=false`; `:100` sidecar | `docs/ELODIN_GROUNDSTATION_SETUP.md:18` (WP12) |
| `deploy/startup/start_tmux_data_to_db_only.sh` | 73 | tmux session `sensor-db-only` (`:6`); `:71` names `./scripts/startup/stop_tmux.sh` (wrong path) | none |
| `deploy/startup/startup.sh` | 34 | `:28,34` tell the user to run `tmux_start_sensors.sh` (not in the tree) | `test/test_system.sh:50,66` (deleted) |
| `sim/setup_sim_network.sh` | 32 | `sudo ip addr add 192.168.2.x/32 dev lo` (Linux `ip`; the stand's board subnet — AGENT-RULES 1) | only the three launchers above (`start_web_gui.sh:127`, `start_fake_data_stack.sh:82-83`, `start_tmux_dev_legacy.sh:163`) |
| `sim/teardown_sim_network.sh` | 31 | the inverse | none |

`stop_tmux.sh:9` kills sessions `sensor-dev sensor-db-only sensor-logs sensor`: `sensor-db-only`
is created only by the deleted `start_tmux_data_to_db_only.sh:60`; `sensor` by nothing in the tree.
Both names **stay** in that line: `stop_tmux.sh` is the stand's "stop everything" (`dev.sh:142-143`,
`e2e_guitest_playwright.sh:31,232`), and killing a session that does not exist is `|| true`. Only
line 35 goes (§2.2).

### 1.2 Test scripts under `test/` (broken: target a binary, module or path that does not exist)

| file | lines | broken dependency | references outside the deleted set |
|---|---|---|---|
| `test/test_fsw_elodin.sh` | 88 | `./build/diablo_fsw` — no CMake target | none |
| `test/test_pt_db.sh` | 40 | `:22-25` `build/daq_comms/send_fake_pt` — `transport/test/send_fake_pt.cpp` was in no target and is deleted by WP2 (WP2-EVIDENCE.md) | `transport/test/send_fake_pt.cpp:147` (deleted by WP2) |
| `test/test_elodin_groundstation.sh` | 61 | `:44` same `send_fake_pt` | `docs/ELODIN_GROUNDSTATION_SETUP.md:39` (WP12) |
| `test/test_system.sh` | 70 | `:41` `./build.sh`, `:50` `source startup.sh`, `:51-52` `cd shell && source startup_db.sh`, `:67` `./shell/tmux_start_sensors.sh` — none exist | `.github/workflows/daq-server-ci.yml:571-572` (orchestrator, §6) |
| `test/test_calibration_system.py` | 130 | `from scripts.channel_plotter import …` — no `channel_plotter` in the tree | none |
| `test/test_human_input_system.py` | 181 | same import | none |

### 1.3 Test scripts under `test/` (working ad-hoc probes, superseded)

All check UDP reception on the DAQ port, SENSOR_CONFIG push or Elodin subscription by hand;
`test_integration.sh` + `ws_data_flow_test.ts` drive real UDP through `daq_bridge` and assert the
same things, and the characterization areas freeze the bytes (`packets/`, `pipeline/`, `lifecycle/`).

| file | lines | references outside the deleted set |
|---|---|---|
| `test/debug_packet_reception.sh` | 59 | none |
| `test/diagnose_network.sh` | 63 | none |
| `test/test_network_connectivity.sh` | 107 | none |
| `test/test_packet_reception.sh` | 53 | none |
| `test/test_udp_reception.sh` | 57 | none |
| `test/verify_packet_reception.sh` | 90 | `README.md:50` (tree listing; WP12) |
| `test/capture_raw_packets.py` | 80 | none |
| `test/send_sensor_config_manual.py` | 71 | none (its own usage line says `scripts/test/…`) |
| `test/test_robustness_system.py` | 371 | none (tests `tools/calibration/calibration_robustness.py`, a parked tree; writes `./test_backups`, `./test_logs`) |
| `test/test_udp_receive.py` | 44 | none |
| `test/ws_rate_probe.ts` | 96 | none (`:11-15` documents running it by hand from `diablo_server/backend`) |

### 1.4 `archive/legacy/python-services/data_logger_service.py`

Run only by `start_tmux_dev_legacy.sh:175` (`--ws-url ws://127.0.0.1:8081`). The two fallbacks
that stay (`heartbeat_service.py`, `config_broadcast_service.py`) do not import it (grep of the
three Python files for `data_logger`: nothing); `config_broadcast_service.py:41` imports
`config_packet_builder`, which therefore stays with them. Other mentions: `archive/README.md:18`
(deleted by WP2), `archive/legacy/python-services/README.md:23-29` (edited here, §2.3),
`test/characterization/pipeline/README.md:173-175` and LEDGER D21 (cite it as the archived logger —
orchestrator, §6), `config/config_base.toml:23` `[data_logger_service]` (config; D5 frozen, D21
records it as unused — untouched). `check_env.sh:265` and `flash/README.md:23,112` name the C++
binary `build/bin/data_logger_service`, not this file.

---

## 2. What WP4 edits

### 2.1 `test/test_integration.sh` — the `--legacy` branch (one commit)

The branch has been unrunnable, not merely dead: `set -euo pipefail` (33) and `$TEST_RELAY_WS_PORT`
at 850, which nothing in the repo defines (`git grep TEST_RELAY_WS_PORT` → only that line), so
`--legacy` dies on an unbound variable before `npx tsx src/server-legacy.ts` (857) could fail on
the missing file. CI never passes `--legacy` (`daq-server-ci.yml:669,779` run the script bare).

| line(s) | today | change |
|---|---|---|
| 19 | `#   bash test/test_integration.sh [-v\|--verbose] [--legacy] [--only=<ids>]` | drop ` [--legacy]` |
| 21 | `#   --legacy   Use server-legacy.ts instead of server.ts (default: thin backend).` | delete |
| 36 | `BACKEND=thin` | **keep** (read at 228 and 1161) |
| 42 | `    --legacy) BACKEND=legacy ;;` | delete |
| 228 | `echo "  Full-Stack Integration Test  [backend: $BACKEND]"` | keep (output byte-identical) |
| 762-763 | `# Provides TCP command endpoint on :9998. Both thin and legacy backends forward` / `# state/actuator commands here. Reads Elodin port from the test config.` | `# Provides TCP command endpoint on :9998. The backend forwards state/actuator` / `# commands here. Reads Elodin port from the test config.` (S38) |
| 833 | `if [ "$BACKEND" = "thin" ]; then` | delete (a one-armed `if` on a constant is the same dead branch) |
| 834-842 | the `server.ts` start | keep, de-indented by two spaces |
| 843-857 | `else` … `npx tsx src/server-legacy.ts …) &` | delete |
| 858 | `fi` | delete |
| 1161 | `--backend="$BACKEND" $SEQ_FLAG …` | **keep**: `ws_data_flow_test.ts:41` defaults `--backend` to `'legacy'`, and its `IS_THIN` branches are parked (BLOAT-MAP §4; `environmental-recovery.integration.ts:109` also passes `--backend=thin`). `ws_data_flow_test.ts` is not edited. |

Dry run on an extracted copy (the exact verify command, §4.1): 19 lines removed, 1205 lines
after, `bash -n` clean; `grep -n -i legacy` afterwards hits only `:434` (`INTEGRATION_GUI_MODE=throttle`,
the GUI stream's legacy mode — unrelated, keep) and `:821` (`archive/legacy/python-services/…`, the
parked fallback). H1's park/restore (85, 185-189, 913) and H2's `[Config] ERROR` guard are not in
any touched range.

### 2.2 `deploy/startup/stop_tmux.sh` — one line

Delete 35 (`pkill -f "${REPO_ROOT}/diablo_server/backend.*server-legacy\.ts"`). **Keep 36**
(`elodin-relay\.ts`): `elodin-relay.ts` and `npm run relay` are Parked (LEDGER), and
`tools/postprocessing/replay_past_db.sh:99` (live dev, parked tree) still runs `npm run relay`, so
the stop script must still stop it. Keep 40 (`calibration_server.py`: the sidecar is under parked
`tools/calibration/`), 37 (`dist/server.js`: BLOAT-MAP §1 says leave) and 32 (`next dev`).
BLOAT-MAP's "drop `server-legacy`/relay pkill lines" is narrowed to the first by the relay's PARK.

### 2.3 `archive/legacy/python-services/README.md`

Delete 22-29 (the blank line before `## data_logger_service.py` through `**Requires:** …`) in the
same commit as the file. Its own directory's README, no other owner (WP12's list stops at
`*/README.md` of the top-level dirs and `tools/**/*.md`).

### 2.4 `deploy/startup/start_tmux_dev.sh:3` — comment only

`# Legacy monolithic backend is available via start_tmux_dev_legacy.sh.` → delete the line. Not in
BLOAT-MAP's WP4 list, but no package owns the live launcher and the DoD is "no remaining reference to
deleted files outside WP12's docs". Lines 5-6 (`data_logger defaults`, `(no relay)`) describe ports
and the backend's own connection; keep.

### 2.5 `test/test_ota_flash.py:57` — one line

Delete `        os.path.join(daq_root, "build-ci", "FSW", "ota_service"),` (the second of three
candidates in `find_ota_service()`, 50-69). WP1 deleted `build-ci/`; CI sets `OTA_SERVICE_BIN`
(`daq-server-ci.yml:540-543`) so the candidate list is never consulted there; every local build
puts the binary at the first candidate `build/bin/ota_service` (WP1-EVIDENCE.md §1). The not-found
message (63-67) prints the remaining two candidates. No black on an existing file (S39).

### 2.6 `test/test_integration.sh:296-297, 368-370` — the two fossil comments (comment-only commit)

WP2 deletes `archive/legacy/pre-daqv2-tools/fake_packet_generator.cpp` and hands these to WP4
(WP2-EVIDENCE.md:58). Keep both warnings — they explain two rules the script still follows — and
mark the file deleted:

- 296: `# A previous targeted list here omitted fake_packet_generator, so the test ran` →
  `# A previous targeted list here omitted fake_packet_generator (since deleted), so the test ran`
- 368-370: `# NOTE: transport/src/fake_packet_generator.cpp is a pre-DAQv2 fossil (0xAA` /
  `# magic + XOR framing the current daq_bridge cannot parse) with no CMake` /
  `# target — never use it here even if someone makes it buildable again.` →
  `# NOTE: the old fake_packet_generator.cpp (pre-DAQv2: 0xAA magic + XOR framing the` /
  `# current daq_bridge cannot parse; deleted by WP2) was never a data source here —` /
  `# never reintroduce a hand-built packet generator even if someone writes one.`

### 2.7 `test/test_stacklight.sh` — wire it (see §3)

---

## 3. The orphan test: `test/test_stacklight.sh`

61 lines; nothing runs it (`git grep test_stacklight` → nothing). Hermetic: `--force-state <n>
--config /dev/null --target-ip 127.0.0.1 --target-port 5099 --interval-ms 200` (13-14), then a
Python receiver asserts `len == 10`, `data[0] == 14` and `data[6:] == red,yellow,green,buzzer` for
14 states (40-53). Every flag exists (`stacklight_service_main.cpp:188-201`); `--force-state` skips
the Elodin thread (290-293); `/dev/null` yields no overrides (`getTomlValue` returns `""`, 239-261);
the first send is immediate (`last_send` initialised one interval back, 307). Port 5099 is bound by
nothing else in the repo.

**Overlap, stated.** C1's `packets/golden/service_stacklight.txt` (merged) already freezes the exact
STACKLIGHT_COMMAND bytes for every state 0-25, 254, 255, reached black-box through a stand-in
Elodin; its light bytes agree with all 14 expectations here (e.g. state 1 → `00 00 01 00`, 16-19 →
`01 00 00 01`, 255 → `01 01 01 01`). `config/bin_dump.py:184-190` already runs the binary with
`--force-state 1` for its startup lines. What this script alone covers is the `--force-state` →
packet path (golden: Elodin-row → packet; bin_dump: `--force-state` → startup log). That is a real
but thin margin; §7 asks the orchestrator to drop the registration under D49 if it is judged not to
earn a fixed-port ctest.

**Registration (decided: wire it).** `diablo_server/services/CMakeLists.txt`, after line 65 (the
`stacklight_service` link block; the Python find and the `add_test` shape are
`services/t7_bridge/CMakeLists.txt:34-43`):

```cmake
# Hermetic: --force-state, UDP to 127.0.0.1:5099, no Elodin. Lights per state are also frozen
# black-box in test/characterization/packets/golden/service_stacklight.txt.
find_package(Python3 COMPONENTS Interpreter)
if(Python3_Interpreter_FOUND)
    add_test(NAME stacklight_force_state
             COMMAND ${CMAKE_COMMAND} -E env
                     STACKLIGHT_BIN=$<TARGET_FILE:stacklight_service>
                     bash ${CMAKE_SOURCE_DIR}/test/test_stacklight.sh)
    set_tests_properties(stacklight_force_state PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE)
endif()
```

`${CMAKE_SOURCE_DIR}` is `daq-server/` (the top-level `CMakeLists.txt:63-66` runs
`enable_testing()` before `add_subdirectory(diablo_server)`, and t7 uses the same root). TIMEOUT
(D38): 14 states x (start + ≤ 5 s receive) worst case 70 s. RUN_SERIAL: a fixed port, like
`t7_integration`. The script's own `python3` on `PATH` is what every other harness assumes.
Ownership: BLOAT-MAP gives CMake to WP8's slot only to avoid a concurrent editor; D25 serializes
WPs, so WP4 edits `services/CMakeLists.txt` alone. No other CMake file changes. Not a timing test
(`timing_ctests.txt` unchanged); not added to `baseline_ctest_failures.txt` — if it is red on the
pre-WP tip, that is a defect of the script or the service, reported, and the registration is
dropped from the item (§7).

---

## 4. Execution

Branch from the tip after WP2 merges; one queue item (D25); every commit leaves `bash -n` clean on
every touched shell file and `python3 -m py_compile test/test_ota_flash.py` clean. Plain one-line
messages (AGENT-RULES 3). Nothing under `test/characterization/**` or `docs/remaster/**` is edited
by WP4 (C0 owns them; §6 hands the two lines to the orchestrator).

**Commit 1 — delete the launchers and the sim network scripts.**

- [ ] `git rm deploy/startup/{start_tmux_dev_legacy,start_web_gui,start_calibration_stack,stop_calibration_stack,start_fake_data_stack,start_tmux_data_to_db_only,startup}.sh sim/{setup,teardown}_sim_network.sh`
- [ ] `deploy/startup/stop_tmux.sh`: delete line 35 only (§2.2).
- [ ] `deploy/startup/start_tmux_dev.sh`: delete line 3 (§2.4).

**Commit 2 — delete the broken and superseded test scripts.**

- [ ] `git rm test/{test_fsw_elodin,test_pt_db,test_elodin_groundstation,test_system,debug_packet_reception,diagnose_network,test_network_connectivity,test_packet_reception,test_udp_reception,verify_packet_reception}.sh`
- [ ] `git rm test/{capture_raw_packets,send_sensor_config_manual,test_calibration_system,test_human_input_system,test_robustness_system,test_udp_receive}.py test/ws_rate_probe.ts`
- [ ] **Not** `test/test_duplicate_subscription.ts` (§5). **Not** `test/test_udp_simple.py`,
      `scripts/test_udp.py` (Parked: `deploy/setup/fix_board_ip.sh:65`, `scripts/README.md:18`).

**Commit 3 — the Python data logger.**

- [ ] `git rm archive/legacy/python-services/data_logger_service.py`
- [ ] `archive/legacy/python-services/README.md`: delete 22-29 (§2.3).

**Commit 4 — `test_integration.sh`: remove the `--legacy` branch** (§2.1 table; nothing else in
the file).

**Commit 5 — `test_integration.sh`: the two fossil comments** (§2.6; comments only).

**Commit 6 — `test_ota_flash.py:57`** (§2.5).

**Commit 7 — register `test_stacklight.sh`** (§3 CMake block). Before committing, run the script by
hand against the pre-WP build (`STACKLIGHT_BIN=build/bin/stacklight_service bash
test/test_stacklight.sh`, under the stack lock: it binds 5099) and record the 14 `PASS` lines in
the merge row. Mutation (each red, then reverted, recorded): (a) `stacklight_service_main.cpp:50`
`cmd.green = 1;` → `cmd.yellow = 1;` (IDLE goes `FAIL … expected 0,0,1,0`); (b) in the script, line
49 `FIRE 16 1,0,0,1` → `1,0,0,0` (the test must be able to fail on its own table too).

### 4.1 Verify (D19: the oracle is edited, so the full gate with integration and the Linux leg)

- [ ] Per commit: `bash -n` on every touched `.sh`; `git grep -n -I -F -e <stem>` for every deleted
      basename over the whole repo (the §1 method) returns **exactly** the §6 residual list — a
      deterministic diff, not a judgment.
- [ ] Commit 4 byte check, from the parent commit's file:
      ```
      git show HEAD~1:daq-server/test/test_integration.sh \
        | sed -e '843,858d' -e '833d' -e '42d' -e '21d' -e '19s/ \[--legacy\]//' -e '834,842s/^  //' \
              -e '762s/.*/# Provides TCP command endpoint on :9998. The backend forwards state\/actuator/' \
              -e '763s/.*/# commands here. Reads Elodin port from the test config./' \
        | diff - daq-server/test/test_integration.sh && echo IDENTICAL
      ```
      (dry-run on the tip: 1224 → 1205 lines, parses). Re-anchor the numbers if H-series commits
      moved them; the pattern grep in the Baseline finds every site.
- [ ] `bash daq-server/test/characterization/with_stack_lock.sh bash daq-server/test/test_integration.sh`
      on the item's tip: `PASS`, 0 failed; the header still prints `[backend: thin]`; `sha256sum
      scripts/calibration/calibrations/abort_thresholds.txt` identical before and after (H-1).
- [ ] `bash test/test_integration.sh --legacy` is no longer special: the arg falls through the
      `case` (no `*)` arm) and the run is the default run. Record that in the row — it is the one
      observable change to the script.
- [ ] `ctest -R stacklight_force_state` under the lock (commit 7), macOS and the Linux leg.
- [ ] `python3 test/test_ota_flash.py` with `OTA_SERVICE_BIN` unset and `build/bin/ota_service`
      present (first candidate); and with it absent, the not-found text lists two candidates.
- [ ] Full gate (`gate.sh`, with integration) and `linux/linux_gate.sh` (arm64 full) on the item's
      tip; CI dispatch is not required (nothing under the sequencer or scripts moves, D34), but the
      `test` job's "Run integration tests" step (§6) is deleted by the orchestrator in the same
      queue item, so the next dispatch must show the job without that step.
- [ ] `git diff --stat backend-remastered...HEAD -- ':!daq-server/test' ':!daq-server/deploy'
      ':!daq-server/sim' ':!daq-server/archive' ':!daq-server/diablo_server/services/CMakeLists.txt'`
      is empty.

---

## 5. Must not change

| surface | why |
|---|---|
| `test/test_duplicate_subscription.ts` — **untouched, including its stale `scripts/test/` usage comment** (12-16) | the only C6-2 reproducer (D42(e)); run by `test/characterization/lifecycle/lifecycle.py:1182-1195` from `stack.BACKEND_DIR`, output frozen in `lifecycle/golden/dupsub.txt` |
| `test/ws_data_flow_test.ts` (the `IS_THIN` branches, `--backend` default `'legacy'` at 41, the `server-legacy.ts` label at 3728) | the oracle; BLOAT-MAP §4 "do not refactor"; Parked |
| `archive/legacy/python-services/{heartbeat_service,config_broadcast_service,config_packet_builder}.py` | fallbacks: `sensor-heartbeat.service:12`, `sensor-config-broadcast.service:12`, `start_tmux_dev.sh:274,280,371`, `test_integration.sh:821-824`; `config_packet_builder` imported at `config_broadcast_service.py:41` |
| `diablo_server/backend/src/elodin-relay.ts`, `package.json` `relay`, `stop_tmux.sh:36` | Parked; `tools/postprocessing/replay_past_db.sh:99` runs it |
| `backend/package.json` `main`/`start` | Parked |
| `test/test_udp_simple.py`, `scripts/test_udp.py`, `deploy/setup/*`, `tools/**` | Parked (operator fix scripts / operator GUIs) |
| `test_integration.sh` H1 park/restore (85, 185-189, 913), H2 startup board + `[Config] ERROR` guard, the alias block (239-262, §7 Q1), every log line a harness reads (S15) | merged harness fixes; the gate fails on a dirty tracked file |
| `config/config_base.toml:23` `[data_logger_service]` | config loading is frozen (D5); D21 records it unused |
| `test/characterization/**`, `docs/remaster/**` | C0 |
| `tools/postprocessing/**`, `tools/calibration/**` (incl. `calibration_robustness.py`, which the deleted `test_robustness_system.py` exercised) | WP11 parks them |

LEDGER WP4 row's "incl. H-1 done": H1 (`f47aa8e3`) already parks and restores
`abort_thresholds.txt`; nothing remains for WP4 but the sha256 check above.

---

## 6. Lines outside WP4's files (for the orchestrator)

| where | line(s) | what | owner |
|---|---|---|---|
| `.github/workflows/daq-server-ci.yml` (job `test`, "Run Tests") | 569-576 | the step `Run integration tests`: `if [ -f "test/test_system.sh" ]; then chmod +x …; echo "Running smoke tests..."; fi`, `continue-on-error: true` — a no-op today, and with `test_system.sh` gone the `if` is false; delete the whole step in WP4's queue item | orchestrator (outside `daq-server/`) |
| `test/characterization/pipeline/README.md` | 173-175 | cites `archive/legacy/python-services/data_logger_service.py` as the archived (binary `.sensorlog`) logger behind D21; after commit 3 append "(deleted by WP4; `git show <pre-WP4 tip>:…`)" or leave as history — comment-only, D18 | orchestrator (C0) |
| `docs/remaster/LEDGER.md` D21 | — | same citation; add the deleting commit | orchestrator |
| `README.md:50`; `scripts/README.md:24`; `docs/ACTUATOR_PIPELINE_AND_TMUX.md:7,27-28`; `docs/ELODIN_GROUNDSTATION_SETUP.md:18,39`; `tools/gui/README.md:60,160` | — | the residual references to deleted files (the expected output of the §4.1 grep after commit 3) | WP12 |
| `SETUP.md:353` (root) | — | "must pass 58/58" — stale before WP4 (the suite is 167 checks, LEDGER Baseline); not WP4's | orchestrator / WP12 |

Nothing else outside `daq-server/` names any file in §1: root `scripts/aliases.sh:106,122,142`
reach only `e2e_guitest_playwright.sh` and `ensure_frontend_build.sh`; `scripts/setup_common.sh:300-306`
only `tools/aliases.sh`; `docker-compose.yml`, `publish-apps.yml` only the webviewer; `format.sh`
targets no shell or Python here; `firmware/Flight_Computer/flight_test:4` only mentions
`test_integration.sh` as a model.

---

## 7. Open questions

1. **The alias false-✅ (LEDGER WP4 row, reviewer).** `test_integration.sh:255-259`: on macOS a
   missing loopback alias triggers `sudo ifconfig lo0 alias … || true` per octet and then prints
   `✅ Loopback aliases added` whether or not sudo succeeded; the stack then fails later on a bind.
   The fix is a re-check after the loop that lists the still-missing `127.0.0.<i>` and exits 1
   (before anything is launched — the `EXIT` trap at 202 runs `cleanup`, which kills nothing of
   ours). It contradicts BLOAT-MAP's DoD "default path byte-identical except the removed branch"
   only on a misconfigured host, and never on Linux (the block is Darwin-only, 245). Proposed as a
   separate **commit 8**, taken or dropped by the orchestrator: mutation = add octet `99` to
   `LOOPBACK_IPS` and run with `sudo` shadowed by a stub that exits 1
   (`mkdir -p /tmp/stub && printf '#!/bin/sh\nexit 1\n' > /tmp/stub/sudo && chmod +x /tmp/stub/sudo;
   PATH=/tmp/stub:$PATH bash test/test_integration.sh`) → exits non-zero naming `127.0.0.99`
   before any port is bound; revert.
2. **`stacklight_force_state` under D49.** Its marginal coverage over `service_stacklight.txt` and
   `bin_dump.py` is the `--force-state` → packet path alone (§3). If the orchestrator judges that
   not worth a fixed-port ctest, commit 7 becomes `git rm test/test_stacklight.sh` with the overlap
   recorded in the merge row, and the DoD "wire the real orphan test" is closed as "superseded by
   C1". Either way the script does not stay unwired.
3. **`[data_logger_service]` in `config_base.toml:23`** stays because config loading is frozen;
   whether the team wants the section gone is a config change for the team (D21), not WP4.

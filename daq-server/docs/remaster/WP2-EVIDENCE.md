# WP2 evidence: dead C++ and build-orphaned files

Branch `wp/WP2-dead-cpp`, cut from `backend-remastered` @ `b2599617`. One commit deletes 37 files and
edits 5. Nothing compiled changes: the `build/bin` and `build/lib` file lists, the warning set and
the `ctest -N` list are identical before and after (section 4).

The characterization `packets/` area is not on `backend-remastered` yet. It is on `queue/C1`
(`9c62a745`, merged as `char/packets`), and the WP is queued behind `remaster-baseline`, which will
contain it. Every grep below therefore ran on **both** revisions, `backend-remastered` (`HEAD` of
this branch before the commit) and `queue/C1` (`f872c788`). The results are identical, apart from
the packets test noted in section 2.

## 1. Method

`/tmp/wp2/grep.sh <rev>` (reproduced in Appendix A) runs `git grep -n -F -w -I` over **every
tracked file in the whole repo** at the given rev, `node_modules` excluded. That covers
`daq-server/`, `firmware/`, `lib/`, `Test-GUI/`, `.github/`, the root `format.sh` and `Doxyfile`,
and the characterization tests. For each deleted file it searches:

- the basename (`IMUCalibration.cpp`), and
- for C/C++ files with a distinctive stem, the stem as a whole word (`IMUCalibration`). That catches
  `#include <...>`, CMake source lists without an extension, and class names.

Generic basenames (`main.cpp`, `Elodin.hpp`, `Timer.hpp`, `Config.h`, `Matrix.hpp`,
`Messages.hpp`, `LinearAlgebra.hpp`) are searched by basename only. For the READMEs the search is
path-qualified (`archive/README`, `utl/README`, `pre-daqv2-tools/README`). Hits inside the deletion
set itself are dropped. Each hit is classed by file type: CODE (C/C++/CMake), SCRIPT
(sh/py/ts/js/yml/json/toml/service/Doxyfile) or DOC.

Directory-level searches, also over the whole repo:

```
git grep -n -I -E 'legacy/cpp|pre-daqv2|legacy/utl|archive/legacy|transport/test|comms/math|include/nav|nav/EKF|\butl/'
git grep -n -E 'GLOB'       -- '**/CMakeLists.txt' '*.cmake'
git grep -n -i -E 'usockets|uWebSockets'
```

## 2. Deleted files: proof per file

"CODE" means any C, C++ or CMake file in the repo, including `firmware/`, `lib/` and
`test/characterization/**` on both revs. "No target" means the file is in no `add_executable`,
`add_library` or source list, and no `file(GLOB)` reaches it. The only `GLOB`s in daq-server are
`services/CMakeLists.txt` (the usockets block, removed here; it globbed `external/uWebSockets`,
which does not exist) and `test/characterization/CMakeLists.txt` (subdirectories of
`test/characterization`).

| deleted | CODE references | SCRIPT / CI references | DOC references (owner) |
|---|---|---|---|
| `archive/legacy/cpp/actuator_service_main.cpp` | none | none | `build-clang-ci/build.ninja:886,887,903` (tracked junk, WP1); BLOAT-MAP |
| `archive/legacy/cpp/controller_service_main.cpp` | none | none | BLOAT-MAP |
| `archive/legacy/cpp/data_logger/{DataLoggerService.cpp,.hpp,data_logger_main.cpp}` | none | none | none |
| `archive/legacy/cpp/data_logger/sensor-data-logger.service` | none | none (no systemd install script names it) | none |
| `archive/legacy/cpp/fsw_web_bridge.cpp` | only the comment heading the usockets block, `services/CMakeLists.txt:85` (block removed here) | `scripts/export_sensor_config.py:63`, a comment ("fsw_web_bridge can handle the fallback") | `README.md:102,241` (WP12); LEDGER:74 |
| `archive/legacy/cpp/main.cpp` | none naming this file. The `main.cpp` hits are other files' own mains: `tools/CMakeLists.txt:12` (`state_script_check/main.cpp`), comments in `test/characterization/config/{char_config_services.cpp:2,CMakeLists.txt:30}`, and `firmware/**` comments about the boards' own `src/main.cpp` | `Test-GUI/**`, `firmware/test_guis/**` comments, all about firmware `main.cpp` | `docs/CONFIGURATION_GUIDE.md:86`, `docs/IMPROVEMENTS.md:40,52` (other mains, WP12) |
| `archive/legacy/cpp/nav/nav/EKFNavigationEnhanced.cpp` | none (its own `#include "../include/nav/..."` resolves nowhere) | none | `docs/ROBUST_DDP_AND_CALIBRATION.md:83,84,95,102,107` (WP12) |
| `archive/legacy/cpp/sitl/sitl/{SITLSimulator.cpp,.hpp,sitl_main.cpp}` | none (`SITLSimulator.hpp` includes non-existent `nav/EKFNavigation.hpp`) | `flash/flash.sh` listed `sitl_simulator` (entry dropped here) | `flash/README.md` (WP12) |
| `archive/legacy/pre-daqv2-tools/README.md` | none | none | none |
| `archive/legacy/pre-daqv2-tools/fake_packet_generator.cpp` | none | `test/test_integration.sh:296,368`: comments only, explaining why it is *not* built (WP4 owns that script) | BLOAT-MAP |
| `archive/legacy/pre-daqv2-tools/test_{elodin_editor,full_pipeline}.sh` | none | none | none |
| `archive/legacy/utl/dbConfig.hpp` | `archive/legacy/utl/db.hpp:4792`, a comment ("FSW's dbConfig.hpp uses pair()"). Not an include. `db.hpp` must stay byte-identical for WP3's rename, so the comment is left alone | none | none |
| `archive/legacy/utl/Elodin.hpp` | none | none | none |
| `archive/legacy/utl/TCPSocket.hpp` | none naming the file. `class TCPSocket` in `transport/{include,src}/transport/NetworkSocket.*` is a different, live class (parked in BLOAT-MAP) | none | none |
| `archive/legacy/utl/LinearAlgebra.hpp`, `LinearAlgebra_impl.hpp` | none | none | BLOAT-MAP |
| `archive/legacy/utl/README.md` | n/a | none | BLOAT-MAP |
| `archive/README.md` | n/a | none | BLOAT-MAP |
| `transport/include/comms/Timer.hpp` | none, including `queue/C1`'s `packets/comms_messages.cpp` | none | BLOAT-MAP |
| `transport/include/comms/math/{LinearAlgebra,Matrix}.hpp` | only each other (`LinearAlgebra.hpp:8 #include "Matrix.hpp"`) | none | none |
| `transport/include/comms/messages/Messages.hpp` | none (it is an umbrella that includes four headers; nothing includes it, on either rev) | none | BLOAT-MAP |
| `transport/test/{fake_calibrated_pt,send_all_sensors,send_fake_pt}.cpp` | none. They are in no target, and they `#include "../../utl/db.hpp"`, a path that does not exist, so they cannot compile | `test/test_pt_db.sh:22-25`, `test/test_elodin_groundstation.sh:44` name a `build/daq_comms/send_fake_pt` that no build has produced (both scripts are WP4 deletions) | `docs/ELODIN_GROUNDSTATION_SETUP.md:7` (WP12) |
| `lib/include/nav/EKFNavigationEnhanced.hpp` | none (it includes a non-existent `EKFNavigation.hpp`) | none | `docs/ROBUST_DDP_AND_CALIBRATION.md:83,84,95,102,107` (WP12) |
| `lib/include/calibration/IMUCalibration.hpp`, `lib/src/calibration/IMUCalibration.cpp` | `lib/CMakeLists.txt:42` `# src/calibration/IMUCalibration.cpp (disabled)`, a comment (removed here). `test/characterization/calibration/lib_harness.cpp:9-10`, a comment saying it is deliberately not covered because it does not compile (C0-owned, left as is). No `#include "IMUCalibration` anywhere: not in `RobustCalibrationManager`, `SensorCalibration`, `calibration_main.cpp` or any test | none | `docs/ROBUST_DDP_AND_CALIBRATION.md` (13 lines), `tools/calibration/README_IMU.md:64,67`, `test/characterization/calibration/README.md:71` (WP12 / C0); LEDGER:157 |
| `lib/test/test_imu_calibration.cpp` | none (no `add_executable`) | `flash/flash.sh:30` (entry dropped here) | `flash/README.md:12,108`, `docs/IMPROVEMENTS.md:188-193` (WP12); `flash/dependencies.txt:13` (entry dropped here) |
| `lib/include/Config.h` | `lib/include/config/Config.hpp:10`, a comment ("distinct from ... lib/include/Config.h"; removed here). No `#include "Config.h"`; the live header is `config/Config.hpp` | none | none |
| `backend/register-vtables-helper.cpp` | none | none | BLOAT-MAP |
| `backend/test_massive_sub.js` | n/a | none. It is not in `package.json`. vitest's default include (`*.{test,spec}.*`) does not match it, and `tsconfig.json` includes only `src/**` | BLOAT-MAP |

Directory-level results:

- `archive/legacy/cpp`, `pre-daqv2`, `transport/test`, `comms/math`, `include/nav`: no hits in any
  build file, script or CI workflow. The only hits outside docs are
  `test/characterization/pipeline/README.md:174` (prose, C0) and `build-clang-ci/build.ninja`
  (stale generated file from another machine's `/home/aidan/Diablo-FSW`, WP1).
- `archive/legacy/utl` (`db.hpp` stays, so every one of these still resolves):
  `lib/CMakeLists.txt:60` and `services/CMakeLists.txt:7` (include paths, needed for `db.hpp`),
  `test/characterization/config/CMakeLists.txt:10`, `test/characterization/gate.sh:118`
  (`git ls-files` for format_check), `githooks/pre-push:22,26`, root `format.sh:28`,
  `.github/workflows/daq-server-ci.yml:227,303,325,383,397`.
- `uWebSockets`/`usockets`: the only build reference was the guarded block in
  `services/CMakeLists.txt:85-99`. No target links `usockets`, and `external/uWebSockets` is
  neither tracked nor present.

### Kept although listed as a candidate: the characterization tests compile them

`queue/C1:daq-server/test/characterization/packets/comms_messages.cpp` (target `char_comms_messages`,
test `char_packets_comms_messages`) includes, at lines 26-48:

| header | include line |
|---|---|
| `transport/include/comms/BarometerMessage.hpp` | `comms_messages.cpp:26` |
| `comms/CalibrationMessage.hpp` | `:27` |
| `comms/EngineControlMessage.hpp` | `:29` |
| `comms/GPSMessage.hpp` | `:30` |
| `comms/IMUMessage.hpp` | `:31` |
| `comms/NavigationMessage.hpp` | `:32` |
| `comms/PTMessage.hpp` | `:33` |
| `comms/RTDMessage.hpp` | `:34` |
| `comms/SystemHealthMessage.hpp` | `:35` |
| `comms/TCMessage.hpp` | `:36` |
| `comms/ValveControlMessage.hpp` | `:37` |
| `comms/messages/control/ControlMessages.hpp` | `:40` |
| `comms/messages/filtered/FilteredMessages.hpp` | `:42` |
| `comms/messages/flight/FlightMessages.hpp` | `:43` |

BLOAT-MAP's WP2 row lists the 11 `*Message.hpp` headers, `messages/flight/**` and
`messages/filtered/**` as dead. They were dead when the map was drawn. The packets
characterization now freezes their `CommsMessage` aliases, so they are **kept**. To check this, a
clean export of `tmp/wp2-verify` with `BarometerMessage.hpp` and `FlightMessages.hpp` removed fails
`cmake --build build --target char_comms_messages` with
`comms_messages.cpp:26:10: fatal error: 'comms/BarometerMessage.hpp' file not found`.

**WP3 must know:** its file list deletes `messages/control/ControlMessages.hpp` "with
PressureStateMachine". The packets test includes it (`comms_messages.cpp:40`), so WP3 has to keep it
or change C0's test.

### Kept: other files

- `archive/legacy/utl/db.hpp`: the live Elodin encoder. WP3 moves it.
- `archive/legacy/python-services/**`: parked. These are systemd and `start_tmux_dev.sh` fallbacks,
  and `data_logger_service.py` belongs to WP4.
- `flash/flash.sh`, `flash/dependencies.txt`: edited, not deleted. BLOAT-MAP's WP2 row says "drop
  dead targets", and `flash/README.md` (WP12) documents the script as an operator tool. Seven
  executable entries that no target builds are dropped from both lists: `send_all_sensors_from_config`,
  `send_all_message_types`, `test_fsw_simulator`, `esp32_pt_streamer`, `fake_esp32_packet_gen`,
  `sitl_simulator` and `test_imu_calibration`. `daq_bridge` and `test_robust_ddp` stay; both are
  targets. Behaviour is unchanged: `flash.sh` already skipped missing executables with a warning.
  The stale `scripts/startup/*.sh` entries and the comment block in `dependencies.txt` are not
  targets and are left for WP12.

## 3. Edits

| file | change | effect on the build |
|---|---|---|
| `diablo_server/services/CMakeLists.txt` | remove the `uWebSockets`/`usockets` block (old lines 85-99) | the configure log loses one line, `-- uWebSockets not found, skipping usockets`; nothing else changes |
| `diablo_server/lib/CMakeLists.txt` | remove the comment `# src/calibration/IMUCalibration.cpp  (disabled)` | none |
| `diablo_server/lib/include/config/Config.hpp` | remove the comment naming `lib/include/Config.h` | none (comment only; clang-format 19.1.7 clean) |
| `flash/flash.sh`, `flash/dependencies.txt` | drop the seven dead executable entries | none (`bash -n flash.sh` ok) |

## 4. Verification

### (a) Clean builds, same path, before and after

`git archive <rev> daq-server lib` was extracted to `/tmp/wp2/before/src` and built with
`cmake -S src/daq-server -B build -Wno-dev && cmake --build build -j8` (Apple clang, macOS). The rev
was `backend-remastered` for the before build and `wp/WP2-dead-cpp` for the after build, at the same
path, so the warning text compares exactly.

- `find build/bin build/lib` (48 files: 46 binaries and the 2 shared libraries): **identical**.
- Warnings (with line and column numbers stripped): **identical**. Both are 10 unique warnings,
  equal to `test/characterization/baseline_warnings.txt` once the path prefix is removed.
- `ctest -N`: **identical** (34 tests).
- Configure log: the only difference is the removed usockets status line.

### (b) ctest -L characterization -R 'packets|elodin|config' (native, under the stack lock)

These tests ran on the throwaway verification merge `tmp/wp2-verify`, which is `queue/C1` (`f872c788`) plus `wp/WP2-dead-cpp` (merge commit `2de05043`, local only, deleted afterwards). The `packets/` and `elodin/` areas exist only from `queue/C1` onward. The tree was built in the worktree with `cmake -S daq-server -B daq-server/build && cmake --build`, after `npm ci` in backend and frontend. The build had the same 29 warning lines as the before build. The command was `bash test/characterization/with_stack_lock.sh ctest -L characterization -R 'packets|elodin|config'`. The 1-minute load was 4.96 when the run queued and 3.58 when it finished.

```
 1/15 Test #34: characterization_config_cpp .............   Passed   14.05 sec
 2/15 Test #35: char_elodin_schema_config_base ..........   Passed   44.65 sec
 3/15 Test #36: char_elodin_schema_profile_default ......   Passed   35.60 sec
 4/15 Test #37: char_packets_wire_layout ................   Passed    0.24 sec
 5/15 Test #38: char_packets_wire_encode ................   Passed    0.00 sec
 6/15 Test #39: char_packets_wire_decode ................   Passed    0.00 sec
 7/15 Test #40: char_packets_wire_malformed .............   Passed    0.00 sec
 8/15 Test #41: char_packets_pipeline_decode ............   Passed    0.38 sec
 9/15 Test #42: char_packets_comms_messages .............   Passed    0.35 sec
10/15 Test #43: char_packets_service_config_broadcast ...   Passed   10.20 sec
11/15 Test #44: char_packets_service_heartbeat ..........   Passed   14.97 sec
12/15 Test #45: char_packets_service_stacklight .........   Passed   12.46 sec
13/15 Test #46: char_packets_service_daq_bridge .........   Passed    5.51 sec
14/15 Test #47: char_packets_service_abort ..............   Passed   27.17 sec
15/15 Test #48: char_packets_service_pwm ................   Passed   16.53 sec
100% tests passed, 0 tests failed out of 15
```

A mutation check shows the packets test really guards the headers kept in section 2. Removing `BarometerMessage.hpp` makes `char_comms_messages` fail to compile.

### (c) linux_gate.sh --areas packets,elodin,config

Command: `bash test/characterization/linux/linux_gate.sh --areas packets,elodin,config tmp/wp2-verify`, run on `2de05043`, linux/arm64, gcc-12, inside the script's own stack-lock hold.

```
── npm                ok
── build              ok
── characterization   ok
LINUX GATE: PASS
```

Characterization step:

```
 1/15 Test #34: characterization_config_cpp .............   Passed    6.04 sec
 2/15 Test #35: char_elodin_schema_config_base ..........   Passed   42.76 sec
 3/15 Test #36: char_elodin_schema_profile_default ......   Passed   35.33 sec
 4/15 Test #37: char_packets_wire_layout ................   Passed    0.00 sec
 5/15 Test #38: char_packets_wire_encode ................   Passed    0.00 sec
 6/15 Test #39: char_packets_wire_decode ................   Passed    0.00 sec
 7/15 Test #40: char_packets_wire_malformed .............   Passed    0.00 sec
 8/15 Test #41: char_packets_pipeline_decode ............   Passed    0.03 sec
 9/15 Test #42: char_packets_comms_messages .............   Passed    0.00 sec
10/15 Test #43: char_packets_service_config_broadcast ...   Passed    9.68 sec
11/15 Test #44: char_packets_service_heartbeat ..........   Passed   14.87 sec
12/15 Test #45: char_packets_service_stacklight .........   Passed   12.26 sec
13/15 Test #46: char_packets_service_daq_bridge .........   Passed    5.46 sec
14/15 Test #47: char_packets_service_abort ..............   Passed   27.11 sec
15/15 Test #48: char_packets_service_pwm ................   Passed   16.49 sec
100% tests passed, 0 tests failed out of 15
[golden] ts_registry.json: match
[golden] ts_protocol.json: match
CHARACTERIZATION: PASS
```

## 5. Lines outside daq-server

None needs to change for WP2. Every root-level reference names `archive/legacy/utl`, which still
holds `db.hpp`:

- `format.sh:28`: `"daq-server/archive/legacy/utl"` in `TARGETS`
- `.github/workflows/daq-server-ci.yml:227`: ccache key
  `hashFiles(..., 'daq-server/archive/legacy/utl/**/*.cpp', 'daq-server/archive/legacy/utl/**/*.hpp', ...)`.
  The deletions change the hash value once (a cold ccache on the first CI run), not the key's shape.
- `.github/workflows/daq-server-ci.yml:303,325,383,397`: the TODO, include, secrets and unsafe-function
  greps over `diablo_server/ archive/legacy/utl/`. All are warning-only (`|| true` or
  `continue-on-error`), so fewer files means fewer warnings and cannot fail.
- `Doxyfile:60-63` INPUT includes `daq-server`, and `Doxyfile:86` excludes `daq-server/archive`.
  Deleted non-archive headers simply drop out of the generated docs, so no change is needed.

All of these change only when WP3 moves `db.hpp`.

## Appendix A: grep script

```bash
#!/usr/bin/env bash
# Usage: bash /tmp/wp2/grep.sh <rev>   (run from the worktree root)
# For every file in /tmp/wp2/del.txt, grep its basename (and, for C/C++ files with a distinctive
# stem, the stem as a whole word) across every tracked file of the whole repo at <rev>
# (node_modules excluded), dropping hits inside the deletion set itself. CODE and SCRIPT hits are
# printed in full; DOC hits are listed as file:line only.
rev="$1"
DEL=/tmp/wp2/del.txt
classify() {
  case "$1" in
    *.c|*.cc|*.cpp|*.h|*.hpp|*.ino|*CMakeLists.txt|*.cmake) echo CODE ;;
    *.sh|*.py|*.ts|*.mts|*.js|*.mjs|*.yml|*.yaml|*.json|*Doxyfile|*Makefile|*.toml|*.service|*.ini|*.ps1|*format.sh) echo SCRIPT ;;
    *) echo DOC ;;
  esac
}
while read -r f; do
  base="${f##*/}"
  pats=()
  case "$f" in
    # generic basenames: path-qualified patterns only
    */archive/README.md) pats=("archive/README" "archive/README.md") ;;
    */utl/README.md) pats=("utl/README") ;;
    */pre-daqv2-tools/README.md) pats=("pre-daqv2-tools/README") ;;
    */legacy/cpp/main.cpp) pats=("main.cpp") ;;
    *) pats=("$base")
       case "$base" in
         Elodin.hpp|Timer.hpp|Config.h|Matrix.hpp|Messages.hpp|LinearAlgebra.hpp) ;;  # stem too generic
         *.cpp|*.hpp|*.h) pats+=("${base%.*}") ;;
       esac ;;
  esac
  echo "### $f   [patterns: ${pats[*]}]"
  for p in "${pats[@]}"; do
    git grep -n -F -w -I "$p" "$rev" -- . ':!**/node_modules/**' 2>/dev/null | sed "s|^$rev:||"
  done | sort -u | while IFS= read -r line; do
      path="${line%%:*}"
      grep -qxF "$path" "$DEL" && continue
      c=$(classify "$path")
      if [ "$c" = DOC ]; then
        rest="${line#*:}"; echo "  [DOC] $path:${rest%%:*}"
      else
        echo "  [$c] $line" | cut -c1-240
      fi
    done
done < "$DEL"
```

## Appendix B: raw hits on backend-remastered (the queue/C1 output is byte-identical)

```
### daq-server/archive/legacy/cpp/actuator_service_main.cpp   [patterns: actuator_service_main.cpp actuator_service_main]
  [DOC] daq-server/build-clang-ci/build.ninja:886
  [DOC] daq-server/build-clang-ci/build.ninja:887
  [DOC] daq-server/build-clang-ci/build.ninja:903
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:194
### daq-server/archive/legacy/cpp/controller_service_main.cpp   [patterns: controller_service_main.cpp controller_service_main]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:194
### daq-server/archive/legacy/cpp/data_logger/DataLoggerService.cpp   [patterns: DataLoggerService.cpp DataLoggerService]
### daq-server/archive/legacy/cpp/data_logger/DataLoggerService.hpp   [patterns: DataLoggerService.hpp DataLoggerService]
### daq-server/archive/legacy/cpp/data_logger/data_logger_main.cpp   [patterns: data_logger_main.cpp data_logger_main]
### daq-server/archive/legacy/cpp/data_logger/sensor-data-logger.service   [patterns: sensor-data-logger.service]
### daq-server/archive/legacy/cpp/fsw_web_bridge.cpp   [patterns: fsw_web_bridge.cpp fsw_web_bridge]
  [CODE] daq-server/diablo_server/services/CMakeLists.txt:85:# ── uWebSockets (optional, for future fsw_web_bridge) ────────────────────────
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:194
  [DOC] daq-server/docs/remaster/LEDGER.md:74
  [DOC] daq-server/README.md:102
  [DOC] daq-server/README.md:241
  [SCRIPT] daq-server/scripts/export_sensor_config.py:63:    # fsw_web_bridge can handle the fallback.
### daq-server/archive/legacy/cpp/main.cpp   [patterns: main.cpp]
  [CODE] daq-server/diablo_server/tools/CMakeLists.txt:12:    state_script_check/main.cpp
  [DOC] daq-server/docs/CONFIGURATION_GUIDE.md:86
  [DOC] daq-server/docs/IMPROVEMENTS.md:40
  [DOC] daq-server/docs/IMPROVEMENTS.md:52
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:194
  [CODE] daq-server/test/characterization/config/char_config_services.cpp:2:// and cannot be linked against. Each service's main.cpp is #included into its own executable (the
  [CODE] daq-server/test/characterization/config/CMakeLists.txt:30:# One executable per service main, each #including that main.cpp (see char_config_services.cpp).
  [DOC] firmware/ADC_Testing/Noise_Characterization/README.md:13
  [DOC] firmware/ADC_Testing/Self_Test/README.md:9
  [DOC] firmware/ADC_Testing/Simple_Test_Adnan/README.md:10
  [DOC] firmware/ADC_Testing/Simple_Test/README.md:10
  [DOC] firmware/Archive/OldAdnanStuff/Simple_Test_Adnan/README.md:10
  [CODE] firmware/Bluetooth_Switch/include/status.h:17:    FLAG_NO_BATTERY = 1 << 3,   // J1-3 below BATTERY_PRESENT_MIN_MV (main.cpp)
  [DOC] firmware/Bluetooth_Switch/README.md:133
  [DOC] firmware/Bluetooth_Switch/sdkconfig.defaults:2318
  [DOC] firmware/Bluetooth_Switch/sdkconfig.defaults:2323
  [DOC] firmware/Ethernet OTA Testing/README.md:44
  [CODE] firmware/Hotfire_Code/Hotfire_Tests/test/test_actuator_state_machine/test_actuator_state_machine.cpp:22:// (extracted from Actuator_Hotfire/src/main.cpp for testability)
  [CODE] firmware/Hotfire_Code/Hotfire_Tests/test/test_actuator_state_machine/test_actuator_state_machine.cpp:47:// Replicate getBoardStateForHeartbeat() from Actuator_Hotfire/main.cpp
  [CODE] firmware/Hotfire_Code/Hotfire_Tests/test/test_actuator_state_machine/test_actuator_state_machine.cpp:5: * functions. Because these are static in Actuator_Hotfire/main.cpp with tightly
  [CODE] firmware/Hotfire_Code/Hotfire_Tests/test/test_actuator_state_machine/test_actuator_state_machine.cpp:72:// Replicate applyPacketTransition() from Actuator_Hotfire/main.cpp
  [DOC] firmware/LC_Board/LC_Calibration/LC_Calibration_Gui/README.md:51
  [SCRIPT] firmware/test_guis/ball_valve_gui.py:50:# BallValve_Hotfire/src/main.cpp.
  [SCRIPT] Test-GUI/Actuator-GUI/actuator_gui.py:21:  * firmware/Hotfire_Code/Actuator_Hotfire/src/main.cpp  (10 actuators,
  [DOC] Test-GUI/Actuator-GUI/README.md:127
  [SCRIPT] Test-GUI/boardgui/demo_actuator_board.py:5:It behaves like the real firmware's UDP side (Actuator_Hotfire/src/main.cpp):
  [SCRIPT] Test-GUI/boardgui/profile.py:10:  * firmware        : firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp
  [SCRIPT] Test-GUI/boardgui/profile.py:22:# LC_Hotfire/src/main.cpp), not the ESP32's 3.3 V logic rail. AVDD is the 5 V
  [SCRIPT] Test-GUI/boardgui/serial_parse.py:42:# (Actuator_Hotfire/src/main.cpp stateName()).
  [SCRIPT] Test-GUI/boardgui/serial_parse.py:6:firmware_hash.h, and LC_Hotfire/src/main.cpp):
  [DOC] Test-GUI/README.md:96
  [DOC] Test-GUI/Sense-GUI/README.md:165
  [SCRIPT] Test-GUI/Sense-GUI/sense_gui.py:22:  * firmware  `firmware/Hotfire_Code/<BOARD>_Hotfire/src/main.cpp`
### daq-server/archive/legacy/cpp/nav/nav/EKFNavigationEnhanced.cpp   [patterns: EKFNavigationEnhanced.cpp EKFNavigationEnhanced]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:215
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:102
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:107
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:83
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:84
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:95
### daq-server/archive/legacy/cpp/sitl/sitl/SITLSimulator.cpp   [patterns: SITLSimulator.cpp SITLSimulator]
### daq-server/archive/legacy/cpp/sitl/sitl/SITLSimulator.hpp   [patterns: SITLSimulator.hpp SITLSimulator]
### daq-server/archive/legacy/cpp/sitl/sitl/sitl_main.cpp   [patterns: sitl_main.cpp sitl_main]
### daq-server/archive/legacy/pre-daqv2-tools/README.md   [patterns: pre-daqv2-tools/README]
### daq-server/archive/legacy/pre-daqv2-tools/fake_packet_generator.cpp   [patterns: fake_packet_generator.cpp fake_packet_generator]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:195
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:204
  [SCRIPT] daq-server/test/test_integration.sh:296:# A previous targeted list here omitted fake_packet_generator, so the test ran
  [SCRIPT] daq-server/test/test_integration.sh:368:# NOTE: transport/src/fake_packet_generator.cpp is a pre-DAQv2 fossil (0xAA
### daq-server/archive/legacy/pre-daqv2-tools/test_elodin_editor.sh   [patterns: test_elodin_editor.sh]
### daq-server/archive/legacy/pre-daqv2-tools/test_full_pipeline.sh   [patterns: test_full_pipeline.sh]
### daq-server/archive/legacy/utl/dbConfig.hpp   [patterns: dbConfig.hpp dbConfig]
  [CODE] daq-server/archive/legacy/utl/db.hpp:4792:                    // compatibility Convert Pair to Component (FSW's dbConfig.hpp uses pair() but
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:191
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:220
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/archive/legacy/utl/Elodin.hpp   [patterns: Elodin.hpp]
### daq-server/archive/legacy/utl/TCPSocket.hpp   [patterns: TCPSocket.hpp TCPSocket]
  [CODE] daq-server/diablo_server/transport/include/transport/NetworkSocket.hpp:116:class TCPSocket : public NetworkSocket {
  [CODE] daq-server/diablo_server/transport/include/transport/NetworkSocket.hpp:123:    TCPSocket(const std::string& remote_address, uint16_t remote_port);
  [CODE] daq-server/diablo_server/transport/include/transport/NetworkSocket.hpp:125:    ~TCPSocket() override;
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:218:TCPSocket::TCPSocket(const std::string& remote_address, uint16_t remote_port) : socket_fd_(-1) {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:222:TCPSocket::~TCPSocket() {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:228:void TCPSocket::setup_socket(const std::string& remote_address, uint16_t remote_port) {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:258:ssize_t TCPSocket::receive(uint8_t* buffer, size_t max_size) {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:278:ssize_t TCPSocket::send(const uint8_t* data, size_t size) {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:295:bool TCPSocket::is_valid() const {
  [CODE] daq-server/diablo_server/transport/src/transport/NetworkSocket.cpp:299:std::string TCPSocket::last_error() const {
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:191
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:220
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:221
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:352
### daq-server/archive/legacy/utl/LinearAlgebra.hpp   [patterns: LinearAlgebra.hpp]
### daq-server/archive/legacy/utl/LinearAlgebra_impl.hpp   [patterns: LinearAlgebra_impl.hpp LinearAlgebra_impl]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:191
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:220
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/archive/legacy/utl/README.md   [patterns: utl/README]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:295
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/archive/README.md   [patterns: archive/README archive/README.md]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:194
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:295
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/diablo_server/transport/include/comms/Timer.hpp   [patterns: Timer.hpp]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:209
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/diablo_server/transport/include/comms/math/LinearAlgebra.hpp   [patterns: LinearAlgebra.hpp]
### daq-server/diablo_server/transport/include/comms/math/Matrix.hpp   [patterns: Matrix.hpp]
### daq-server/diablo_server/transport/include/comms/messages/Messages.hpp   [patterns: Messages.hpp]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:211
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/diablo_server/transport/test/fake_calibrated_pt.cpp   [patterns: fake_calibrated_pt.cpp fake_calibrated_pt]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:212
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:214
### daq-server/diablo_server/transport/test/send_all_sensors.cpp   [patterns: send_all_sensors.cpp send_all_sensors]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:214
### daq-server/diablo_server/transport/test/send_fake_pt.cpp   [patterns: send_fake_pt.cpp send_fake_pt]
  [DOC] daq-server/docs/ELODIN_GROUNDSTATION_SETUP.md:7
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:143
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:144
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:214
  [SCRIPT] daq-server/test/test_elodin_groundstation.sh:44:echo "      ./build/daq_comms/send_fake_pt $DB_PORT 1000"
  [SCRIPT] daq-server/test/test_pt_db.sh:22:TEST_BIN="$PROJECT_ROOT/build/daq_comms/send_fake_pt"
  [SCRIPT] daq-server/test/test_pt_db.sh:24:    echo "❌ Error: send_fake_pt not found at $TEST_BIN"
  [SCRIPT] daq-server/test/test_pt_db.sh:25:    echo "   Build it first: cmake --build build --target send_fake_pt"
### daq-server/diablo_server/lib/include/nav/EKFNavigationEnhanced.hpp   [patterns: EKFNavigationEnhanced.hpp EKFNavigationEnhanced]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:215
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:102
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:107
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:83
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:84
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:95
### daq-server/diablo_server/lib/include/calibration/IMUCalibration.hpp   [patterns: IMUCalibration.hpp IMUCalibration]
  [CODE] daq-server/diablo_server/lib/CMakeLists.txt:42:    # src/calibration/IMUCalibration.cpp  (disabled)
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:216
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
  [DOC] daq-server/docs/remaster/LEDGER.md:157
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:138
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:139
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:146
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:155
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:156
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:157
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:161
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:170
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:180
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:196
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:96
  [CODE] daq-server/test/characterization/calibration/lib_harness.cpp:10:// on main (IMUCalibration.hpp:92 default-argument / :203 unqualified SensorType), so there is no
  [CODE] daq-server/test/characterization/calibration/lib_harness.cpp:9:// Not covered, on purpose: IMUCalibration.cpp is commented out of fsw_daq_lib and does not compile
  [DOC] daq-server/test/characterization/calibration/README.md:71
  [DOC] daq-server/tools/calibration/README_IMU.md:64
  [DOC] daq-server/tools/calibration/README_IMU.md:67
### daq-server/diablo_server/lib/src/calibration/IMUCalibration.cpp   [patterns: IMUCalibration.cpp IMUCalibration]
  [CODE] daq-server/diablo_server/lib/CMakeLists.txt:42:    # src/calibration/IMUCalibration.cpp  (disabled)
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:216
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
  [DOC] daq-server/docs/remaster/LEDGER.md:157
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:138
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:139
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:146
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:155
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:156
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:157
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:161
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:170
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:180
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:196
  [DOC] daq-server/docs/ROBUST_DDP_AND_CALIBRATION.md:96
  [CODE] daq-server/test/characterization/calibration/lib_harness.cpp:10:// on main (IMUCalibration.hpp:92 default-argument / :203 unqualified SensorType), so there is no
  [CODE] daq-server/test/characterization/calibration/lib_harness.cpp:9:// Not covered, on purpose: IMUCalibration.cpp is commented out of fsw_daq_lib and does not compile
  [DOC] daq-server/test/characterization/calibration/README.md:71
  [DOC] daq-server/tools/calibration/README_IMU.md:64
  [DOC] daq-server/tools/calibration/README_IMU.md:67
### daq-server/diablo_server/lib/test/test_imu_calibration.cpp   [patterns: test_imu_calibration.cpp test_imu_calibration]
  [DOC] daq-server/docs/IMPROVEMENTS.md:188
  [DOC] daq-server/docs/IMPROVEMENTS.md:191
  [DOC] daq-server/docs/IMPROVEMENTS.md:193
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:216
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:293
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
  [DOC] daq-server/flash/dependencies.txt:13
  [SCRIPT] daq-server/flash/flash.sh:30:    "test_imu_calibration"          # IMU calibration test (if built)
  [DOC] daq-server/flash/README.md:108
  [DOC] daq-server/flash/README.md:12
### daq-server/diablo_server/lib/include/Config.h   [patterns: Config.h]
  [CODE] daq-server/diablo_server/lib/include/config/Config.hpp:10:// NOTE: distinct from the unrelated legacy global `class Config` in lib/include/Config.h.
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:217
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/diablo_server/backend/register-vtables-helper.cpp   [patterns: register-vtables-helper.cpp register-vtables-helper]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:218
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
### daq-server/diablo_server/backend/test_massive_sub.js   [patterns: test_massive_sub.js]
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:219
  [DOC] daq-server/docs/remaster/BLOAT-MAP.md:331
```

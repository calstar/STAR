# Characterization area: config

Freezes what every config loader makes of every tracked config (`config/*.toml`,
`config/profiles/**`, `system_config.json`, `video.json`) and of the bad inputs in
`fixtures/bad/`. Conventions: `../README.md`. `CHAR_UPDATE=1` regenerates.

| half | runs | lock | goldens |
|---|---|---|---|
| C++ library | ctest `characterization_config_cpp` → `check.sh cpp` | no (opens no sockets) | `golden/cpp/` |
| TypeScript | `run.sh` → `check.sh ts` (`ts_dump.ts`, `npx tsx`) | no | `golden/ts/` |
| Python | `run.sh` → `check.sh py` (`py_dump.py`) | no | `golden/py/` |
| service binaries | `run.sh` → `check.sh bin` (`bin_dump.py`) | **yes**, only this half | `golden/bin/` |

## How each golden is reached

Black-box or public API, which a refactor of the service mains keeps:

- `golden/cpp/config`, `csv`, `script_parse`, `script_validate`, `fixed.txt`: public library
  APIs only (`config::load`/`load_from_string`, `active_boards`, `pt_boards`, `pt_role_tables`,
  the Elodin table functions, `build_slug_tables`, `resolvePWMTargets`, `StateMachine`,
  `load_dynamic_states`, the script `parse`/`validate`, and `ActuatorCommander`'s public
  `load`/`positionsForState`/`delayForRole`), with one exception below.
- `golden/cpp/state_script_check`: the built `state_script_check` binary.
- `golden/bin/daq_bridge`, `bin/stacklight`, `bin/config_broadcast`: the built service binaries.
  Each config is copied with `192.168.2.N` rewritten to `127.0.0.N` (`127.0.0.1` for
  config_broadcast), so nothing is ever addressed to the board LAN. daq_bridge is observed through
  its startup log up to `[System] Mode` (its board routing table), stacklight through its startup
  lines (`--force-state`, no Elodin), and config_broadcast through its log plus every datagram of
  its first cycle, received on 127.0.0.1 listeners.

White-box, kept because they cannot be reached otherwise without changing the golden:

- `golden/cpp/config/*.txt`, section `=== ActuatorCommander`, the `bind_addr_ = …` line and the
  `role "…" = {…}` lines: read through `char_ac_private.cpp`, the only `#define private public`
  left. No public method reports a resolved role (board IP, channel, polarity, PWM ownership,
  command table) or the bind address. Their only observable effect is a UDP send to the board
  address, which is 192.168.2.x on every shipped profile and must never be sent.
- `golden/cpp/daq_bridge`, `golden/cpp/stacklight` and `golden/cpp/config_broadcast`: reached
  by `#include`-ing the service's `*_main.cpp` (`char_config_services.cpp`). They freeze
  file-static functions (`load_board_map_from_config` with every out-parameter and the source-IP
  resolution, `getTomlValue` on raw strings, `parseVentAbortFromCsv` and `buildPackets` with the
  configured 192.168.2.x addresses in the packet bytes) at a resolution the binaries do not
  expose. A running binary shows the routing table, the parsed values and the packets, but only
  with rewritten addresses and without the raw intermediate values. So these files cannot be
  produced black-box byte for byte. Their behaviour is covered black-box by `golden/bin/`
  (same inputs). When the refactor splits these mains, these three directories are the ones
  expected to need re-pointing; `golden/bin/` is the contract that survives.

No golden line has been removed or loosened by moving to the black-box route.

# DESIGN-WP9 — split `calibration_main.cpp`

Target-design note required by D17(a) before WP9 starts. Design only: nothing here has been
built or run. Every line number below is
`diablo_server/services/calibration/calibration_main.cpp` (2139 lines) on `backend-remastered`
@ `b2599617`, whose product code equals `main` @ `15b5a0c5`, unless another file is named. The
BLOAT-MAP §4 ranges were a draft; these are re-anchored and differ in places (e.g. the Elodin
connect block is 1477-1562, the read loop 1564-2128).

**Prerequisites:** C1 (`packets/`, `elodin/`) merged into `backend-remastered`; WP8 pass 1 merged;
the "must close before WP9" characterization in §7 merged and gated (tares-before-reload, G5,
G1 Blend); DESIGN-WP8 gap 1 (`kill -PIPE`) merged before cleanup C1.

**Orchestrator decisions recorded here (design review):** placing the new TUs under
`services/calibration/` (not `lib/`) is accepted. BLOAT-MAP's "main < 400" DoD is **waived**: the
target is ~430 lines after move-only, with `main` holding argv, construction in today's order,
the loop head with dispatch, and shutdown. There is no C1b. The move-only pass and the cleanup
pass are **separate queue items, each fully gated**.

Constraints that shape everything below: D17 (behaviour bit for bit, no single-user
abstractions, move-only split first, then cleanup), D18/D20 (harness), D22 + the LEDGER WP9 row
(no arithmetic reordering; robust predictions held at abs 1e-9 psi), the Parked SIGPIPE entry
(calibration_service takes the default disposition and dies on SIGPIPE; it keeps doing so), C3-1
(robust predictions depend on wall-clock time between calls; kept), C6-9 (exit 1 when Elodin is
not up; kept), D34 (macOS timer overshoot).

## 0. Boundary with WP8

BLOAT-MAP's WP8 adoption list is heartbeat, stacklight, config_broadcast, ota, controller,
sequencer (+ AbortBroadcaster) and t7_bridge. **It does not adopt calibration_service**, although
B3 lists `calibration_main.cpp` as one of the Elodin subscribe/reconnect sites and B5/B6 count it
among the signal and argv copies. So when WP9 starts, these three pieces are still hand-written in
this file:

| piece | lines | WP8 helper it maps to |
|---|---|---|
| signal handler + install | 459-462, 656-657 | `fsw::service::installStopHandlers(kPrintThenStop, "\n[CalibrationService] Caught signal, shutting down...", Sigpipe::kDefault)` (DESIGN-WP8 §2.1 table) |
| argv parsing | 597-617 | none: DESIGN-WP8 §0 rejects a shared parser; stays in this file |
| Elodin connect / register / subscribe / reconnect / refusal retry | 1477-1548, 1565-1609 | none: DESIGN-WP8 §0 rejects a generic `SubscriberLoop` (calibration's "first connect fails → exit 1", uninterruptible 2 s sleep and tracker are its own); stays calibration's |

WP9 does **not** touch them in the move-only pass: they stay in `calibration_main.cpp`, verbatim.
WP9's cleanup pass adopts the one WP8 helper that applies, the stop handlers, as a per-service
setting (§6.2 C1). DESIGN-WP8 (committed beside this note) shares no argv parser and no
subscriber loop, so the other two pieces stay calibration's own code.

## 1. Current responsibilities and shared state

### 1.1 Responsibilities by line range

| lines | what | notes |
|---|---|---|
| 1-71 | file doc, includes | |
| 73-152 | anonymous-namespace globals (see 1.2) | |
| 154 | `static std::atomic<bool> running{true}` | written by the signal handler |
| 156-164 | `verbose()`, `env_flag_true()` | `getenv` on every call |
| 166-261 | PT/LC model enums' parse/lookup/name helpers: `parse_pt_model`, `pt_model_for`, `pt_full_scale_for` (default 1000), `pt_sense_resistor_for` (default 120), `pt_model_name`, `parse_lc_model`, `lc_model_for` (default Linear), `lc_streams_physics`, `lc_*_for`, `lc_model_name` | read globals |
| 263-278 | `convert_ratiometric_pt_to_pressure` | pure |
| 280-309 | `select_pt_psi` | reads `g_env_override`, `g_pt_model`; **the Blend arithmetic** (300) |
| 311-329 | `select_lc_kg` | reads `g_lc_model` |
| 331-395 | `convert_hp_pt_to_pressure` | `getenv("CAL_HP_MA_HYST")` per call; mutates the caller's `live_state` (hysteresis latch) |
| 397-457 | `convert_tc_adc_to_temp_c`, `clamp_tc_rtd_temp_publish_c`, `convert_rtd_adc_to_temp_c`, `convert_act_adc_to_current`, `convert_lc_adc_to_force` | pure (call lib `type_k_c_from_mv`, `rtd::rtd_board_adc_to_temp_c`) |
| 459-462 | `signalHandler` | prints to `std::cout` from the handler (not async-signal-safe; BLOAT-MAP defect 6, kept) |
| 464-477 | `unix_now`, `mono_ns` | the doc comment at 464-466 belongs to `mono_ns` (it is misplaced above `unix_now`) |
| 479-530 | `resolve_pt_sensor_uid`, `resolve_lc_sensor_uid` | identical bodies, deliberately duplicated (comment 505-509) |
| 532-594 | `kMinAbortCalPoints`, `invert_abort_psi_to_adc` | bisection over the streaming forward model |
| 596-617 | `main`: defaults + argv | `--help` exits 0 before anything else |
| 619-651 | adjustments-path discovery | `CAL_BACKUP_PATH`, else newest `calibration_backups/calibration_backup_*.json` by mtime |
| 653-657 | banner, signal install | |
| 659-702 | config load, PT/TC/RTD/LC manager construction + loads, counts printed | |
| 704-762 | active boards, PT board configs, HP slot prints, `[calibration.*]` defaults + prints | lambdas `or_default` 661, `boards_of` 709, `current_loop_board` 727 |
| 764-830 | env override, PT per-sensor models/physics params into globals | |
| 832-879 | LC per-sensor models/params into globals | |
| 881-911 | T7 map, T7 models into globals | |
| 913-921 | `uid_role` (ordered, T7 excluded) | main local |
| 927-992 | cubic store, tare store, capture window construction; channel registration (PT, LC, T7) | fills `g_lc_uids`, `g_lc_board_ids` |
| 994-1259 | capture/clear lambdas (table 1.3) | capture main locals by reference |
| 1261-1283 | seed live store from `cubic_calibration.default.json` | |
| 1285-1391 | `reload_live_store` lambda | |
| 1393-1475 | startup: prints, **tare load (1404) before first reload (1410)**, stale-tare audit, `cubic_store.save()`, model summaries | ordering is load-bearing |
| 1477-1548 | Elodin client, `register_calibrated`, `raw_tables`, `subscribe_all`, `connect_and_register`; `return 1` on failure (1544-1545); recv timeout 1000 ms | WP8 territory |
| 1550-1562 | loop state: `pkt_buf[65536]`, `packet_count`, unused `logged_ch5` (baseline warning), `last_save`, `last_adc_map`, `command_dedupe` | |
| 1564-1609 | loop head: reconnect (2 s sleep), refused-subscription retry, read, ErrorResponse | WP8 territory |
| 1611-1627 | header bytes `[4]`,`[5]`,`[6]` by index; type filter; first-10 debug log (`static int debug_limit`) | |
| 1629-1821 | `0x46` CalibrationCommand handler, cmd 0-8 | |
| 1823-1911 | LabJack T7 raw (`type_hi == 0x26`) | |
| 1913-1968 | ESP32 raw filter + 21-byte payload decode | `static int ch_mismatch_warn` 1951 |
| 1970-2114 | ESP32 publish: PT 0x20, TC 0x21, RTD 0x22, LC 0x23, ACT 0x30→0x31, ball valve | inside one `begin_batch`/`flush_batch` |
| 2116-2127 | count log every 10000, 5-min robust auto-save | **only reached on the ESP32 path** |
| 2130-2139 | shutdown: save robust, save cubic, `[Cal] Stopped.`, `return 0` | |

### 1.2 Shared state

File-scope (anonymous namespace, 73-152), all single-threaded:

| global | written | read |
|---|---|---|
| `g_hp_ma_live` (map slot → 11 latches) | `convert_hp_pt_to_pressure` via 1996 | same |
| `g_pt_smoother` (`PtSmoother`, lib header-inline) | 1879, 2015 | same |
| `g_pt_model`, `g_uid_role`, `g_pt_full_scale`, `g_pt_sense_resistor` | 780-830, 897-906 | lookups, abort thresholds, capture logs |
| `g_env_override` | 773-778 | `select_pt_psi`, 1073, 1436, 1871, 2004 |
| `g_lc_model`, `g_lc_full_scale`, `g_lc_sensitivity`, `g_lc_pga_gain` | 836-879, 908 | LC lookups |
| `g_lc_uids`, `g_lc_board_ids` | 961-985 | `is_lc_uid`, summaries |
| `g_t7_cold_junction_c` | 1840 | 1896 |
| `running` (atomic, file static) | signal handler | 1564 |

Function-local statics: `debug_limit` (1621) is **one counter shared by two logs** — "Received
packet" (< 10, 1622) and "Dropped small payload" (< 20, 1935); `ch_mismatch_warn` (1951, < 8);
`logged_ch5` (1558, unused, `baseline_warnings.txt` entry keyed to this file).

### 1.3 The lambdas and what they capture

All `[&]` over `main`'s frame. Captured locals: `cal_cfg`, `pt_calibration`, `robust_manager`,
`lc_calibration`, `t7_map`, `uid_role`, `adjustments_path`, `cubic_store`, `lc_tare_store`,
`capture_window`, `pt_board_configs` (through `current_loop_board`), `lc_sensitivity_mv_per_v`,
`lc_pga_gain`, `lc_full_scale_value`, plus the globals.

| lambda | lines | calls |
|---|---|---|
| `sample_robust_curve` | 999-1020 | `robust_manager.predict_pressure_psi` ×41 |
| `write_abort_thresholds` | 1032-1108 | `invert_abort_psi_to_adc`, writes `abort_thresholds.txt` via `.tmp` + rename |
| `apply_pt_capture` | 1110-1125 | store add/fit → `pt_calibration` → robust update → fit curve → `cubic_store.save` → `save_adjustments` → `write_abort_thresholds` |
| `lc_eval_for` | 1130-1156 | returns `std::function` capturing `[&, uid]` |
| `recompute_tare`, `recompute_all_tares` | 1164-1175 | tare store under its mutex calls the evaluator |
| `apply_lc_capture` | 1178-1187 | |
| `take_capture`, `capture_detail` | 1194-1211 | `mono_ns()` |
| `is_lc_uid` | 1216-1219 | |
| `apply_capture` | 1220-1225 | |
| `apply_pt_clear`, `apply_lc_clear`, `apply_clear` | 1228-1259 | |
| `reload_live_store` | 1294-1391 | ends with `write_abort_thresholds()` then `recompute_all_tares()` |
| `register_calibrated`, `raw_tables`, `subscribe_all`, `connect_and_register` | 1483-1542 | Elodin |
| `publish` (T7) | 1851-1856 | per packet |

### 1.4 Threads, mutexes, lock order

- **One thread.** `main` runs everything; no `std::thread` here or in any lib object it uses
  (`lib/src/calibration/*` and `ElodinClient` start none). `<mutex>`/`<thread>` are included only
  for `sleep_for`.
- Mutexes exist only inside lib objects, taken per call, uncontended:
  `CubicCalibrationStore::mutex_`, `LcTareStore::mutex_`, `RobustCalibrationManager::mutex_`,
  `ElodinClient::publish_mutex_`.
- **The one nesting:** `LcTareStore::{set,recompute,recompute_all,recompute_stale}` hold
  `LcTareStore::mutex_` while invoking the evaluator from `lc_eval_for` (`LcTareStore.cpp`
  60-142). The evaluator touches only `lc_calibration` and `t7_map` (no mutex). Order:
  `LcTareStore::mutex_` → nothing. An evaluator that reached into `lc_tare_store` or
  `cubic_store` would self-deadlock or invert an order; the split must keep its body verbatim.
- Signal handler races `std::cout` with the main thread (kept). `running` is checked only at the
  loop head; shutdown latency is ≤ the 1 s recv timeout, or ≤ 2 s if inside the reconnect sleep.

## 2. Target boundaries

All new files go under `diablo_server/services/calibration/` and are compiled **into the
`calibration_service` executable only** — not into `fsw_daq_lib`. BLOAT-MAP WP9 proposed
`lib/src/calibration/{Conversions,SensorModelRegistry,CalibrationController}.cpp`; rejected
because (a) every piece has exactly one consumer, calibration_service (D17(d)); (b) service
state does not belong in the lib.

Namespace for everything new: `fsw::calibration_service` (lib uses `fsw::calibration`).

| file | contents (moved verbatim) | public interface | users |
|---|---|---|---|
| `Conversions.hpp` (header-only) | 263-278, 331-457, 464-477, 479-530 | `inline` `convert_ratiometric_pt_to_pressure`, `convert_hp_pt_to_pressure`, `convert_tc_adc_to_temp_c`, `clamp_tc_rtd_temp_publish_c`, `convert_rtd_adc_to_temp_c`, `convert_act_adc_to_current`, `convert_lc_adc_to_force`, `unix_now`, `mono_ns`, `resolve_pt_sensor_uid`, `resolve_lc_sensor_uid`; constants `kRatiometricPtZeroFrac/SpanFrac` | RawStream, AbortThresholds, CalibrationActions |
| `SensorModels.hpp` / `.cpp` | enums 91, 127; globals 80-150 (declared `extern` in the header, defined in the `.cpp`); helpers 156-261, 286-329 as header `inline`; config fill 773-879 → `load_pt_lc_models(cfg)` and 894-911 → `load_t7_models(cfg, t7_map)` (889-893 stay in main between them); registration 943-992 → `register_store_channels(cubic_store, pt_boards, lc_boards, t7_map)`; summaries 1436-1472 → `print_model_summary()` | the above | main, RawStream, AbortThresholds, CalibrationActions, CalibrationCommands |
| `CalibrationActions.hpp` / `.cpp` | `struct CalibrationContext` (references, §3); lambdas 999-1259 and 1294-1391 → free functions taking `CalibrationContext&`; `current_loop_board` 727-732 | `sample_robust_curve`, `apply_capture`, `apply_clear`, `take_capture`, `capture_detail`, `is_lc_uid`, `lc_eval_for`, `recompute_tare`, `recompute_all_tares`, `reload_live_store`, `current_loop_board` (the PT/LC-specific `apply_*` stay file-`static`) | main, CalibrationCommands, AbortThresholds |
| `AbortThresholds.hpp` / `.cpp` | 532-594, 1032-1108 | `write_abort_thresholds(CalibrationContext&)` (`kMinAbortCalPoints`, `invert_abort_psi_to_adc` file-`static`) | CalibrationActions (capture, clear, reload) |
| `CalibrationCommands.hpp` / `.cpp` | 1630-1821 | `void handle_calibration_command(CalibrationContext&, CommandDedupe&, const uint8_t* pkt_buf, ssize_t pkt_len)` | main loop |
| `RawStream.hpp` / `.cpp` | 1826-1911, 1913-2127; globals `g_hp_ma_live`, `g_pt_smoother`, `g_t7_cold_junction_c` (file-scope in this TU, anonymous namespace kept) | `struct StreamState`; `void handle_t7_raw(...)`, `void handle_esp32_raw(...)` | main loop |
| `calibration_main.cpp` | 596-760, 913-938 (construction), 1261-1283, 1393-1435 + calls, 1474-1621 loop head, 2130-2139 | `main` | — |

Why each split is not a single-user abstraction: the files are translation units, not
abstractions. The two structs are mechanical carriers of `main`'s existing locals, with no
methods, virtuals or getters: `CalibrationContext` is needed because the functions that replace the
~15 capture/clear/reload lambdas live in three TUs and read the same `main` locals those lambdas
captured; `StreamState` holds the loop locals two handlers
share. `Conversions.hpp` and `SensorModels.hpp` each have ≥ 3 including TUs.

`calibration_main.cpp` is ~430 lines after move-only; `main` holds argv, construction in today's
order, the loop head with dispatch, and shutdown. Cleanup C1 (stop handlers) removes ~8 more.
BLOAT-MAP's "main < 400" DoD is waived by the orchestrator; there is no C1b, and the Elodin
connect/register/subscribe lambdas (1477-1548) stay in `main`.

## 3. Ownership and data flow

`main` owns every object, constructed in today's order and at today's line positions (they have
side effects: `load_calibration` prints, constructors register paths). Right after the capture
window is constructed (938-942) and the store channels are registered, `main` builds:

```cpp
// CalibrationActions.hpp
struct CalibrationContext {
    const fsw::config::Config& cal_cfg;
    const std::map<uint8_t, fsw::config::PtBoardConfig>& pt_board_configs;
    const fsw::t7::T7CalibrationMap& t7_map;
    const std::map<uint16_t, std::string>& uid_role;
    const std::string& adjustments_path;
    fsw::calibration::PTCalibrationManager& pt_calibration;
    fsw::calibration::RobustCalibrationManager& robust_manager;
    fsw::calibration::SensorCalibrationManager& lc_calibration;
    fsw::calibration::CubicCalibrationStore& cubic_store;
    fsw::calibration::LcTareStore& lc_tare_store;
    fsw::calibration::CaptureWindow& capture_window;
    const double lc_sensitivity_mv_per_v, lc_pga_gain, lc_full_scale_value;
};
```

On reconnect (1564-1578), the clear at 1575 becomes **`stream.last_adc_map.clear();`** (the map
now lives in `StreamState`); `capture_window.clear()` at 1574 is unchanged. Both stay in main's
loop head, in that order, before `[Cal] Reconnected to Elodin`.

and, before the loop, `StreamState` (RawStream.hpp): references to `elodin_client`,
`tc_calibration`, `rtd_calibration`, `pt_boards`, `lc_boards`; copies of the const doubles
`tc_adc_ref_voltage`, `rtd_adc_ref_voltage`, `rtd_excitation_ua`, `rtd_r0_ohm`; and the owned loop
locals moved from 1557-1562: `int packet_count = 0`, `int debug_limit = 0` (the function-static,
now a member: same single counter, same zero start, `main` runs once), `last_save`,
`last_adc_map`. `command_dedupe` stays a `main` local passed to the command handler. `pkt_buf`
and `logged_ch5` stay in `main` (the baseline warning stays attributed to this file).

Data flow per loop iteration is unchanged:

```
main loop head (reconnect / due re-subscribe / read / ErrorResponse / header filter / debug log)
  ├─ type_hi 0x46     → handle_calibration_command → CalibrationActions → AbortThresholds
  │                                                 → files: cubic_calibration.json,
  │                                                   adjustments, abort_thresholds.txt, lc_tare.json
  ├─ type_hi 0x26     → handle_t7_raw     → begin_batch, publish, flush_batch, ++packet_count
  └─ 0x20-0x24,0x30,BV → handle_esp32_raw → begin_batch, publish, flush_batch, ++packet_count,
                                            10000-count log, 5-min auto-save
```

Mutex ownership is unchanged (§1.4): no new mutex, no new thread. Lifetimes: every evaluator
returned by `lc_eval_for` captures `CalibrationContext&` and `uid`; `LcTareStore` uses
evaluators only for the duration of the call (`const Evaluator&` parameters; it stores only the
numeric fingerprint), and the context lives in `main`'s frame for the process lifetime.

## 4. Error handling today, kept identical

There are no exceptions caught in `main` except the `directory_iterator` scan (645); everything
else that throws terminates (SIGABRT). The split adds no `try`/`catch` and removes none.

| condition | today | where |
|---|---|---|
| `--help`/`-h` | usage line (no `--adjustments` in it) to stdout, `return 0`, nothing else runs | 612-616 |
| bad `--elodin-port` | `atoi` → `uint16_t` wrap, no message | 609 |
| unknown arg / flag without value | ignored silently | 602-617 |
| signal before 656 | default action (exit by signal) | |
| missing/malformed config | `fsw::config::load` logs, defaults (C2-4) | 660 |
| T7 config errors | stderr line, continue | 890-893 |
| seed copy failure | stdout line, continue | 1275-1277 |
| abort role unknown / T7 role / no mapping | stderr per role, line omitted | 1049-1090 |
| abort file write failure | stderr `abort_thresholds write failed: …`, continue | 1103-1107 |
| stale tares at startup | stdout WARNING, re-derive, save | 1424-1431 |
| Elodin connect fails at start | stderr `[Cal] Failed to connect to Elodin at H:P`, **`return 1`, after** abort thresholds, cubic store and (stale) tares were already written; shutdown saves do not run (C6-9) | 1525-1528, 1544 |
| subscribe fails at start | stderr line, `return 1` | 1534-1537 |
| disconnect mid-run | stderr `retrying in 2s`, `sleep_for(2 s)` (not interruptible), `reconnect()`; on success re-register, re-subscribe (result ignored), timeout 1000, clear capture window + `last_adc_map`, `[Cal] Reconnected to Elodin`; forever | 1565-1578 |
| ErrorResponse | `sub_tracker.rejected`, log, retried by `due()` | 1602-1609, 1591-1595 |
| short / non-table / own-output / out-of-range packets | skipped silently (small-payload log while `debug_limit < 20`) | 1598-1601, 1616, 1913-1940 |
| CalibrationCommand < 24 bytes | ignored, no log | 1634 |
| duplicate command | dropped by `CommandDedupe` | 1636-1637 |
| unknown `cmd_type` (≥ 9) | "Received CalibrationCommand" log only | 1647 |
| capture with no fresh data | `[Cal] <what> uid=… REJECTED (…)`, no-op | 1194-1203 |
| T7 non-finite volts / unknown table | skipped | 1837-1845 |
| SIGPIPE (Elodin closes during a send) | **default: process dies**; systemd `Restart=always` restarts it | no handler; transport sends without `MSG_NOSIGNAL` |
| SIGINT/SIGTERM | handler prints `\n[CalibrationService] Caught signal, shutting down...`, `running=false`; loop exits; `Saved robust adjustments on shutdown → …` if saved; `cubic_store.save()`; `[Cal] Stopped.`; exit 0 | 459-462, 2130-2138 |

**CalibrationCommand has no reply.** Nothing is sent back on `0x46`; a command's observable
effects are the files it writes, the values published afterwards and its log lines.

How it stays identical: every branch moves with its body. **Only the `continue`s of the outer
read loop that sit inside moved code become `return`**, exactly these: **1637, 1829, 1838, 1841,
1845, 1910, 1915, 1922, 1924, 1930, 1939**. The handler call is the last statement of its branch
in `main`, followed by `continue`, so control reaches the same next statement. **1673, 1789 and
1796 are `continue`s of inner `for` loops inside the 0x46 handler: they stay `continue`.** 1601,
1608, 1617 (loop head) and 1820 (after the 0x46 dispatch) stay in `main` as `continue`. The
specific traps:

- 1820 `continue` after the whole `0x46` block (also when `pkt_len < 24`) stays in main:
  `if (type_hi == 0x46) { handle_calibration_command(...); continue; }`.
- 1910 `continue` after the T7 block, and the T7 early `continue`s at 1829, 1838, 1841, 1845
  (before `begin_batch`): `return` in `handle_t7_raw`; main `continue`s.
- ESP32: the filter at 1913-1940 moves into `handle_esp32_raw` (its `continue`s → `return`,
  before `begin_batch`), and so do 2116-2127: the count log and the 5-minute auto-save stay at
  the handler's tail, so they still run only after an ESP32 packet, never after a T7 or command
  packet.
- The `debug_limit` check at 1621-1627 stays in main's loop head and reads
  `stream.debug_limit`; 1935-1938 reads the same member.

## 5. Naming

- Files: `PascalCase.{hpp,cpp}` as in `services/sequencer/` and `lib/`; `calibration_main.cpp`
  keeps its name (systemd, CMake, docs reference the target, not the file, but nothing gains from
  a rename).
- Moved functions keep their names exactly in the move-only pass (they are grep anchors for the
  doc comments and this note). Lambdas become functions of the same name.
- New names: `CalibrationContext`, `StreamState`, `load_pt_lc_models`, `load_t7_models`,
  `register_store_channels`, `print_model_summary`, `handle_calibration_command`,
  `handle_t7_raw`, `handle_esp32_raw`. No `Manager`, `Controller` or `Registry` (BLOAT-MAP's
  `CalibrationController`/`SensorModelRegistry` would be classes with one user).

## 6. The passes

### 6.1 Move-only pass (one package, merged alone; D12(e))

Rule: cut and paste. Allowed edits are only: `static` → `inline` for functions moved into a
header; `static` kept for functions that stay TU-private; lambda → function signature with the
captured locals reached through `ctx.`/`st.`; `continue` → `return` as listed in §4; added
`#include`s, namespace wrappers and `using` declarations. No expression, literal, string, loop or
statement order changes. No reformatting beyond what clang-format 19 does to the moved text.

Before step 1, on the unchanged tree (Release build, under the stack lock):

```
bash daq-server/test/characterization/with_stack_lock.sh \
  python3 daq-server/test/characterization/calibration/service_run.py \
    --cal daq-server/build-gate/bin/calibration_service \
    --fixtures daq-server/test/characterization/calibration/fixtures > /tmp/wp9-pre.txt
grep -o '"\([^"\\]\|\\.\)*"' daq-server/diablo_server/services/calibration/calibration_main.cpp \
  | sort > /tmp/wp9-literals-pre.txt
```

Steps (each compiles; commit per step or once at the end):

1. **`Conversions.hpp`**: move 263-278, 331-457, 464-477 (keep the stray comment 464-466 with
   `mono_ns`), 479-530. `static` → `inline`. Includes: `<algorithm> <array> <chrono> <cmath>
   <cstdint> <cstdlib> <vector>`, `"calibration/SensorCalibration.hpp"` (rtd), `"calibration/TypeK.hpp"`,
   `"config/LoadActiveBoards.hpp"` (`PtBoardConfig`), `"elodin/DatabaseConfig.hpp"`
   (`BoardChannels`). In `calibration_main.cpp`, `#include "Conversions.hpp"` and
   `using namespace fsw::calibration_service;` after the includes.
2. **`SensorModels.hpp/.cpp`**: enums; globals 80-150 except `g_hp_ma_live`, `g_pt_smoother`,
   `g_t7_cold_junction_c` (they go to RawStream in step 6) declared `extern` in the header, defined
   in the `.cpp` (types and initialisers unchanged: all default-constructed, no cross-TU init
   dependency because nothing reads them before `main`); 156-261 and 286-329 as header `inline`
   (`verbose`, `env_flag_true` included). Into the `.cpp`, as function bodies verbatim (the config fill is two functions, see below); 943-992 →
   `void register_store_channels(fsw::calibration::CubicCalibrationStore&, const
   std::vector<BoardChannels>& pt_boards, const std::vector<BoardChannels>& lc_boards, const
   fsw::t7::T7CalibrationMap&)`; 1436-1472 → `void print_model_summary()`. **889 (`t7_map`
   construction) and 890-893 stay in main** between the LC fill and the T7 fill, so
   the fill is split at that point into `load_pt_lc_models(cal_cfg)` (773-879) and
   `load_t7_models(cal_cfg, t7_map)` (894-911), called at the same positions; the T7 count print
   910-911 goes with `load_t7_models`.
3. **`CalibrationActions.hpp/.cpp`**: the struct of §3; build it in main immediately after the
   last `register_store_channels` call (old 992), before the seed block. Move 727-732
   (`current_loop_board`, now `const PtBoardConfig* current_loop_board(const CalibrationContext&,
   uint8_t)`), 999-1259, 1294-1391 as functions in **the same textual order** they have today.
   `capture_detail` takes no context. `lc_eval_for` returns `[&ctx, uid](double adc) -> double
   {…}` with the body verbatim. `current_loop_board` is also used by the ESP32 PT path (1973):
   it is declared in the header.
4. **`AbortThresholds.hpp/.cpp`**: 532-594 file-`static`; 1032-1108 →
   `void write_abort_thresholds(CalibrationContext& ctx)`. `CalibrationActions.cpp` includes its
   header.
5. **`CalibrationCommands.hpp/.cpp`**: 1631-1819 (the body inside `if (type_hi == 0x46)`) →
   `handle_calibration_command(CalibrationContext&, fsw::calibration::CommandDedupe&,
   const uint8_t* pkt_buf, ssize_t pkt_len)`; the `continue` at 1637 → `return`.
6. **`RawStream.hpp/.cpp`**: `StreamState`; the three stream globals in an anonymous namespace
   in `RawStream.cpp`; 1827-1910 → `handle_t7_raw(CalibrationContext&, StreamState&,
   const uint8_t* pkt_buf, ssize_t pkt_len, uint8_t type_lo)`; 1913-2127 →
   `handle_esp32_raw(CalibrationContext&, StreamState&, const uint8_t* pkt_buf, ssize_t pkt_len,
   uint8_t type_hi, uint8_t type_lo)`. `static int ch_mismatch_warn` stays function-local in
   `handle_esp32_raw`. `pkt_buf` is passed as `const uint8_t*`; the `reinterpret_cast` loads at
   1944, 1960, 1961 are unchanged (same alignment: the buffer is still `main`'s stack array).
7. **`calibration_main.cpp`** keeps: 1-71 (trimmed includes), 154, 459-462, 596-760, 889-893,
   913-938, the calls, 1261-1283, 1393-1435 with calls in place of moved bodies, 1474-1627,
   the three dispatches, 2130-2139. Order of calls in main, which **must equal today's order of
   side effects**: argv → adjustments discovery → banner → `std::signal` ×2 → config load →
   managers + loads + 4 prints → active boards → pt board configs → HP prints → defaults prints →
   `load_pt_lc_models` → `t7_map` + T7 errors → `load_t7_models` → `uid_role` → stores +
   capture window → `register_store_channels` → `CalibrationContext` → seed copy → adjustments
   path prints → **`lc_tare_store.load()`** → **`reload_live_store(ctx, true)`** → stale audit →
   `cubic_store.save()` → `print_model_summary()` → verbose line → Elodin client, lambdas,
   `connect_and_register` / `return 1` → recv timeout → `StreamState` → loop → shutdown.
8. **CMake** (`diablo_server/services/CMakeLists.txt:45`):
   ```cmake
   add_executable(calibration_service
       calibration/calibration_main.cpp
       calibration/SensorModels.cpp
       calibration/CalibrationActions.cpp
       calibration/AbortThresholds.cpp
       calibration/CalibrationCommands.cpp
       calibration/RawStream.cpp)
   target_include_directories(calibration_service PRIVATE ${COMMON_INCLUDES}
       ${CMAKE_CURRENT_SOURCE_DIR}/calibration)
   ```
   No compile option added or removed; the new TUs get exactly the flags `calibration_main.cpp`
   gets. `lib/CMakeLists.txt` is not touched. Root `format.sh` targets
   (orchestrator-owned): check that `services/calibration/*.{hpp,cpp}` are matched; ask the
   orchestrator if not.
9. Format only the touched files with the pinned clang-format 19.1.7.

Checks for the move-only package, all required:

- `git diff --stat backend-remastered...HEAD -- diablo_server/lib` is **empty**.
- String literals: concatenate the new files and `calibration_main.cpp`, extract literals as
  above, sort, `diff` with `/tmp/wp9-literals-pre.txt`: identical (proves every log line,
  path and key moved unchanged).
- Floating literals likewise (`grep -oE '[0-9]+\.[0-9]+([eE][-+]?[0-9]+)?'`): identical
  multiset.
- `/tmp/wp9-post.txt` from the same command on the new build, same machine: `cmp` with
  `/tmp/wp9-pre.txt` **byte-identical** (stronger than the golden's 4 ULP; masked fields are
  masked in both).
- Warnings: `calibration_main.cpp: unused variable 'logged_ch5'` still present, nothing new.
- **Moved-code diff rule.** `git diff -M --color-moved=dimmed-zebra
  --color-moved-ws=allow-indentation-change backend-remastered...HEAD -- diablo_server/services/calibration`:
  every line that is **not** dimmed (i.e. not recognised as moved) must be one of: an
  `#include`; a namespace line (`namespace …{`, `}  // namespace`, `using namespace`);
  `static` → `inline`; a `ctx.` / `st.` (or `stream.`) prefix on a formerly captured local; a
  function signature replacing a lambda head or a `{`/`}` that closes it; one of the listed
  `continue` → `return` lines (§4). Any other non-dimmed line is a review stop.
- **Same-machine and Linux byte identity.** In addition to the macOS check above, run the same
  `service_run.py` pre/post on the **Linux arm64 gcc-12 Release** leg (the build CI and probably
  the stand use; GCC contracts across statements after inlining): `cmp` byte-identical.
- **Same external calls.** `nm -C --undefined-only calibration_service | sort` before and after:
  identical (no lib function newly called or dropped, so no math moved across the lib boundary).
- The guarding runs in §7.

### 6.2 Cleanup pass (separate package, each item its own commit, each gated by §7)

- **C1 adopt WP8 plumbing** (DESIGN-WP8 §2.1; only the stop handlers apply):
  - signals: `installStopHandlers(kPrintThenStop, "\n[CalibrationService] Caught signal, shutting
    down...", Sigpipe::kDefault)` — print the exact line, then clear the flag; **SIGPIPE: default
    (no `SIG_IGN`)**; installed at the same point (after the banner, before config load); every
    read of `running` → `fsw::service::running()`.
  - The two items below are **not** WP8 helpers (DESIGN-WP8 §0 rejects both). They are kept here
    as the exact behaviour that stays in `calibration_main.cpp` through both passes:
  - argv: `--config`, `--host|--elodin-host`, `--port|--elodin-port` (`atoi` → `uint16_t`),
    `--adjustments`, `--help|-h` with today's exact usage text and exit 0; unknown args and
    trailing flags ignored; defaults `config/config.toml`, `127.0.0.1`, `2240`,
    `scripts/calibration/calibrations/adjustments.json` (the discovery at 619-651 compares
    against that default string, so the helper must leave it untouched when not given).
  - Elodin loop behaviour (stays calibration's): initial connect or initial subscribe failure →
    caller returns 1 (no retry, C6-9); on disconnect: the `retrying in 2s` line, a 2 s sleep that
    does **not** watch `running`, `reconnect()`, then on success: register, subscribe (result
    ignored), recv timeout 1000 ms, then a caller hook that clears `capture_window` and
    `last_adc_map`, then `[Cal] Reconnected to Elodin`; every iteration: `sub_tracker.due()`
    re-subscribes; ErrorResponse → `rejected()` + the `DB refused` line. Registration order
    (calibrated tables, ball-valve calibrated, T7 by slot) and subscription order (raw tables,
    then ball valve, then T7, then `[0x46,0x00]`) unchanged — frozen by the elodin schema golden.
- **C2 globals out**: move the `SensorModels` globals into one `SensorModels` value owned by
  `main` and referenced from `CalibrationContext`; the RawStream globals into `StreamState`.
  Helpers take it explicitly. Behaviour identical (no reader before `main`).
- **C3 two duplicates with two users each**: `pt_cal_status(model, fac_ok, has_rob)` for
  1871-1878 / 2004-2011; `board_number_from_uid(uid)` for 1067-1069 / 1142-1144. Integer only.
- **Not in cleanup** (behaviour, contract or arithmetic risk; parked or left):
  merging `resolve_pt_sensor_uid`/`resolve_lc_sensor_uid` (behaviour-neutral but the duplication
  is a documented decision; open question 2); replacing header bytes `[4..7]` with
  `elodin::PacketHeader` (DESIGN-WP8 §0 decided against it; not done); deleting
  `logged_ch5` (removes a `baseline_warnings.txt` line; orchestrator decides); any change to the
  defects (signal-handler I/O, 2 s uninterruptible sleep, SIGPIPE, C3-1, C6-9).

### 6.3 Arithmetic: what moves, what must not

`calculate_pressure` and the robust path **do not live in this file and WP9 does not move
them**:

| function | defined | reached from calibration_main via |
|---|---|---|
| `PTCalibrationCoeffs::calculate_pressure` (`A*x*x*x + B*x*x + C*x + D`) | `lib/include/calibration/PTCalibration.hpp:34-37`, header-inline | only through `PTCalibrationManager::calculate_pressure` (`lib/src/calibration/PTCalibration.cpp:313-322`, out of line); calibration_main never calls the coeffs method directly |
| `RobustCalibrationManager::predict_pressure_psi` | `lib/src/calibration/RobustCalibrationManager.cpp:185-191` | 577, 1016, 1865, 1991 |
| `RobustCalibrationFramework::predict_pressure_psi` | `lib/src/calibration/RobustCalibrationFramework.cpp:364` | via the manager |
| `SensorCalibrationManager::calculate` | `lib/src/calibration/SensorCalibration.cpp` | LC/TC/RTD |

Both cubic evaluation and robust prediction are compiled in lib TUs, out of line from the service.
Their inlining and contraction context should not change while `lib/` is untouched, which the
move-only check enforces; this is an argument, not a proof (LTO is off today, but a lib header
inlined into a moved function compiles in a new TU), so it is backed by the byte-identical
macOS and Linux arm64 gcc-12 outputs and the `nm --undefined-only` check (§6.1). That is how WP9 meets the LEDGER constraint: the robust path and
`calculate_pressure` keep their arithmetic order because WP9 does not touch them.

Floating-point arithmetic that does move (inside `calibration_service`):

| expression | where | contractible to FMA? |
|---|---|---|
| `(1.0 - kFactoryWeight) * psi_rob + kFactoryWeight * psi_fac` | `select_pt_psi` 300 (Blend) | **yes** (mul + add) |
| `alpha_ * value + (1.0 - alpha_) * it->second` | `PtSmoother::step`, lib header-inline, inlined at 1879, 2015 | **yes** |
| `(frac - z) / s * fs` | ratiometric 274 | no (sub, div, mul) |
| `(adc/MAX)*ref`, `(v/r)*1000`, `((i-4)/16)*fs`, `4 + hyst`, `4 - min(…)` | HP 353-391 | no |
| `(adc/MAX)*ref`, `*1000` | TC 405-406 | no |
| `(adc/4095)*3.3` | ACT 440 | no |
| `(s/1000)*g*2^31`, `(adc/code_fs)*fs` | LC 453-456 | no |
| `amin + (amax - amin) * i / kSamples` | `sample_robust_curve` 1014 | no (division between) |
| bisection | 585-592 | integer |

Neither the CMake tree nor `scripts/build.sh` sets `-ffp-contract` (grep of every
`CMakeLists.txt`; only `-Wall …` and the sanitizer flags are added). So the defaults apply:
clang `-ffp-contract=on` (within one expression), GCC `-ffp-contract=fast` (CMake's default
`CMAKE_CXX_EXTENSIONS` gives `-std=gnu++20`; can contract across statements after inlining).
Build types: gate and Linux leg `Release`; CI `Release`, `Debug`, `RelWithDebInfo`;
`flake.nix` `Release`; `scripts/build.sh` sets none (no `-O`).

The two contractible expressions stay where their inlining context is today:

- `select_pt_psi` becomes header-`inline` (not an out-of-line function in another TU) and is
  still inlined into `handle_t7_raw`, `handle_esp32_raw` and the bisection's forward lambda, the
  same three call sites it has today.
- `PtSmoother::step` is still called in the same statement sequence (`psi = g_pt_smoother.step(uid,
  psi);` after `select_pt_psi`) in the same function body (now `handle_*_raw`), in a TU built with
  the same flags.

**Coverage:** the Blend expression is in no golden today; G1 (§7) must close before WP9 with a
reseed case such that changing `kFactoryWeight` 0.25 → 0.75 (line 299) goes red.

Verification of the arithmetic, in addition to the byte-identical same-machine check:

```
CHAR_AREAS=calibration bash daq-server/test/characterization/with_stack_lock.sh \
  bash daq-server/test/characterization/run.sh                 # macOS, Release
bash daq-server/test/characterization/linux/linux_gate.sh --areas calibration <rev>   # arm64 gcc-12
# amd64 gcc-12 Release, emulated, the way C3 ran it (D28); CHAR_EMULATED=1 (queue/C1)
```

Then rebuild at `-O0` (`-DCMAKE_BUILD_TYPE=` empty) and run the calibration area once on macOS:
D22's one-golden-for-every-build rule covers it. A red `robust-prediction` or `published-*`
family is a contract change until proven otherwise; stop and report.

## 7. Guarding characterization

| part | guarded by | notes |
|---|---|---|
| conversions, model selection, cal_status | `calibration/golden/stack.txt` (published float32 at 4 ULP; `published-near-zero` abs 1e-12) | config `fixtures/stack_config.toml`: cubic + physics ratiometric PTs, 4-20 mA PTs (hysteresis, per-role full scale and shunt), LC linear/cubic/physics with per-role params, TC poly + physics, RTD, ACT incl. offsets 0x0B/0x0F, ball valve, T7 PT/TC/RTD/LC/cubic PT |
| abort thresholds | `stack.txt` file snapshots of `abort_thresholds.txt` (cubic, physics, loop, sparse fallback, T7 rejection, unknown role); `generated_unix` normalised | |
| captures, clears, zero/zero-all, tares, reload (cmd 7), dedupe, refused captures, unknown cmd 9, uid 9999 | `stack.txt` published frames + full snapshots of cubic store, `lc_tare.json`, `adj.json` (robust parameters rel 1e-2) | `fitCurve[].psi` masked (C3-1) |
| seed from `cubic_calibration.default.json`; tare-before-reload ordering | `stack.txt` "after startup" and "after restart" snapshots (the restart re-reads tares and store) | the ordering mistake (tares after reload) would leave stale offsets: is it visible? only if the restart's curve differs from the one the tare was taken on; open question 3 |
| SIGTERM exit code, restart | `stack.txt` `service exit code 0`; lifecycle `shutdown.txt`: exit 0 within [0, 3.5] s, `'Saved robust adjustments on shutdown' logged`, `'[Cal] Stopped.' logged`, adjustments written; SIGINT alone: exit 0 within [0, 4] s | log lines tests read: exactly these two, plus lifecycle's `wait_log(r"Elodin\|subscrib")` on startup |
| registration + subscription order and bytes | elodin `## calibration` section (`schema_config_base.txt`, `schema_profile_default.txt`) and `stack.txt` startup frames | elodin/packets areas are on `queue/C1`, **not merged on `backend-remastered`** at the time of writing; read with `git show queue/C1:daq-server/test/characterization/elodin/…` |
| T7 end to end, restart, re-subscribe after late T7 registration (refusal retry with real elodin-db) | ctest `t7_integration` (`test/t7_integration.py`, RUN_SERIAL, 180 s) | in `timing_ctests.txt`; Darwin baseline allowlist; judged on the Linux leg / CI (D31, D34) |
| robust streaming end to end | integration `cal_robust_learn` (config patched to `"Ox Upstream" = "robust"`; asserts > 15 psi move) | loose; integration is the orchestrator's gate |
| lib math (`calculate_pressure`, robust predictions at abs 1e-9) | `calibration/golden/lib.txt` | `lib/` unchanged by WP9 (diff empty); still re-run, since lib headers inline into moved code |

White-box hooks: **none for this file.** `calibration/README.md` and
`calibration/CMakeLists.txt:22` state that `calibration_main.cpp` is reached only through the
built binary; `config/char_config_services.cpp` includes the daq_bridge, stacklight and
config_broadcast mains, not this one; no `#define private public` touches calibration. WP9
re-points no harness file; any harness diff in the WP9 packages is a red flag for review.

Gaps (propose; do not write in WP9). **Must close before WP9:** tares-before-reload (run the
mutation "`lc_tare_store.load()` after the first `reload_live_store()`" against `stack.txt`; if it
stays green, add a "profile swapped on disk while the service is down, then start" case), G5,
and G1 Blend. **Before cleanup C1:** DESIGN-WP8 gap 1. The rest are recorded as accepted:

- **G1 [before WP9] Blend and Robust streaming in the stack golden.** Fixture has no `robust`/`blend` role and
  the harness strips `CAL_*`. Robust values are wall-clock dependent (C3-1), so freeze
  `cal_status`, the frame set, and Blend/Robust values only where `has_robust` is false
  (Robust → 0, Blend → factory) or after a reseed with no learning; mask the rest as `fitCurve`
  is masked. Required minimum: a reseed case with a Blend role whose published value makes the
  mutation `kFactoryWeight` 0.25 → 0.75 (line 299) go red.
- **G2 env overrides** `CAL_USE_FACTORY_PT` / `CAL_USE_ROBUST_BLEND` / `CAL_USE_ROBUST_PT`
  (precedence 773-778, the summary line 1436-1441, abort model 1073), `CAL_HP_MA_HYST=0`.
- **G3 reconnect**: stand-in Elodin drops the connection; expect re-registration, re-subscription,
  and a capture right after reconnect REJECTED (capture window cleared).
- **G4 refusal retry** in the stack: stand-in answers one subscription with ErrorResponse; expect
  a re-subscribe of exactly that table about 1 s later (today only `t7_integration` part 4, with
  real elodin-db, which is skipped when elodin-db is absent).
- **G5 [before WP9] Elodin down at start (C6-9)**: exit code 1, with `abort_thresholds.txt` and
  the cubic store written first, and no `adj.json` written.
- **G6 CLI**: `--help` text and exit 0; adjustments discovery (newest `calibration_backup_*.json`,
  `CAL_BACKUP_PATH`; the harness always passes `--adjustments`).
- **G7 SIGPIPE**: replaced by DESIGN-WP8 gap 1 (`kill -PIPE` on every service; calibration exits
  −13). Must close before cleanup C1.
- **G8 5-minute auto-save**: not practical to freeze (300 s); stays a review item (the tail of
  `handle_esp32_raw`).
- **G9 debug-limit/log text**: not read by any test; held by the literal-multiset check.

## 8. Risks

- **Concurrency.** Single thread, so the split cannot introduce a race unless it adds a thread
  (forbidden). Lock order unchanged (§1.4); the evaluator body must stay verbatim. C4-1
  (sequencer deadlock), C4-2 (double script timeout), C4-3 (abort vs pending stage) are
  sequencer defects, not in this service; nothing here touches them.
- **Order of side effects at startup.** Construction-with-side-effects is the trap: build the
  context struct from references to locals constructed at today's positions; never let a struct
  constructor own and construct them. Tare load before first reload (1404 → 1410) is asserted by
  the code's own audit log (1424-1429) and, partly, by the restart snapshot (open question 3).
- **Hidden control flow in the loop.** `continue` → `return` mapping (§4); the auto-save only
  after ESP32 packets; the shared `debug_limit`.
- **Arithmetic.** §6.3. The risky move would be `select_pt_psi` or the stream branches into the
  shared `-fPIC` lib, or `select_pt_psi` into a separate `.cpp` out of line; both are excluded.
- **Static initialisation.** Globals move from internal to external linkage in move-only (C2
  removes them); they are default-constructed containers with no dynamic-init dependency on
  another TU.
- **Warnings baseline.** `logged_ch5` must stay in `calibration_main.cpp` or the warning moves
  to another file and the gate reads it as new + missing.
- **macOS timer (D34).** The calibration area has no tight timing bound (stack waits with
  `TIMEOUT_S`; lifecycle's 3.5 s / 4 s exit bounds are far above the 1 s recv timeout + 2 s
  reconnect sleep). `t7_integration` is a timing ctest and touches this binary: judge it on the
  Linux leg and CI; if it needs a retry there, run it 10× alone on the WP tip and on the pre-WP
  tip and compare pass rates (D31). This Mac's sleep overshoot (≈ 3.5 ms per 10 ms sleep) makes
  macOS results for it non-evidence either way.

## Open questions

1. Is a two-struct split (`CalibrationContext`, `StreamState`) acceptable to the D17(c) design
   reviewer as "carriers of `main`'s locals", or does the reviewer prefer fewer TUs with the
   command and stream handlers left in `calibration_main.cpp` (main would then stay ~900 lines)?
2. Merge `resolve_pt_sensor_uid` / `resolve_lc_sensor_uid` (identical bodies; comment 505-509
   says the copy was deliberate)? Behaviour-neutral; team's call.
3. (Decided: tares-before-reload must be guarded before WP9; see §7.)
4. (Decided: the < 400-line DoD is waived; no C1b.)
5. `logged_ch5`: delete in cleanup (and the baseline line) or keep?

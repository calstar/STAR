# DESIGN-WP9 — split `calibration_main.cpp`

The "as decided" execution note for WP9 (D17(a)): what an implementer does, in what order, and
why. Decisions: D39 (review; the `main < 400` waiver to ~430), D43(3) (a method-less carrier is
not an abstraction), D45 (deepening; the class lost), and the debate verdict
(`debates/WP9/verdict.md`, ratified under D39; LEDGER **D56**, which also carries the ~730
fallback waiver). How it got here — the reviewed text, its amendments, the alternatives (B a
`CalibrationService` class, C a one-header minimal split), the stub table and the
calibration-save walkthrough — is preserved verbatim in
[`debates/WP9/history.md`](debates/WP9/history.md).

**Baseline.** Every line number below is from `git show backend-remastered:daq-server/<path>` at
`backend-remastered` @ **`e5e257cc`**, whose `diablo_server/` is byte-identical to `main` @
`15b5a0c5` (and to `b2599617`, the reviewed note's anchor). Paths are relative to
`daq-server/diablo_server/` unless they start with `test/`, `docs/` or `lib/CMakeLists.txt`;
harness files named bare (`service_run.py`, `lifecycle.py`, `golden/stack.txt`,
`calibration/CMakeLists.txt`, `baseline_warnings.txt`) are under `test/characterization/`; a
bare number is `services/calibration/calibration_main.cpp` (2139 lines). WP8 does not edit this
file; if WP3 lands first, re-anchor with `grep -n`: the function names, not the numbers, are the
contract.

**Prerequisites.** C1 (`packets/`, `elodin/`) merged into `backend-remastered` (it is on the
tip); WP8 pass 1 merged; the five C0 packages of §7.2 merged and gated (they are test-only,
D32-batchable, and start now in parallel with WP8); DESIGN-WP8 gap 1 (`kill -PIPE`) before
cleanup C1. If only G1 is not green when the rest is, the orchestrator may run WP10 first and
queue WP9 after it.

**Scope.** WP3 → WP8 → **WP9** → WP10. WP9 edits `services/calibration/calibration_main.cpp`,
creates the TUs of §2 beside it, and edits `services/CMakeLists.txt:45`. `lib/` is untouched
(`git diff --stat backend-remastered...HEAD -- diablo_server/lib` empty is a check). No harness
file is re-pointed; a harness diff in a WP9 package is a review stop.

**Rules applied:** D5, D12(e), D17, D18/D20, D22 and the LEDGER WP9 row (no arithmetic
reordering; robust predictions at abs 1e-9 psi, 8e-10 measured), D31/D34, D32, D47 (Tier 0:
free functions and carrier structs); STYLE-S1 (`services/calibration` is snake_case), S2, S7,
S26, S27, S33 (waivers recorded), S34 (D43(3)), S38; Parked SIGPIPE (calibration dies on
SIGPIPE; kept), C3-1 (robust predictions depend on wall-clock time; kept), C6-9 (exit 1 when
Elodin is not up; kept). Defects are reported, never fixed (AGENT-RULES 6).

## 0. The decision

**A′: translation units per concern, two reference carriers, free functions.** `main` keeps
argv, construction in today's statement order, the loop head with dispatch, and shutdown (~430
lines after move-only). The lambdas become free functions over a `CalibrationContext&`; the loop
locals two handlers share become a `StreamState`. Carriers, not a class: construction order
stays `main`'s statements; nothing owns anything it did not own today. Eight files (§2):
`Conversions.hpp` (header-only, `inline`), `SensorModels.hpp/.cpp` (`extern` globals until C2;
`select_*` header-inline), `CalibrationContext.hpp`, `CalibrationActions.hpp/.cpp`,
`AbortThresholds.hpp/.cpp`, `CalibrationCommands.hpp/.cpp`, `RawStream.hpp/.cpp` and
`calibration_main.cpp`, all under `services/calibration/`, compiled into `calibration_service`
only, namespace `fsw::calibration_service` (the lib uses `fsw::calibration`). BLOAT-MAP's
`lib/src/calibration/{Conversions,SensorModelRegistry,CalibrationController}` was rejected at
review: one consumer each (D17(d)), and service state does not belong in the lib.

**Queue.** One move-only queue item with two internal checkpoints (the D49(10) shape), then a
separate cleanup item (D12(e)). Checkpoint 1 = steps 1-5 of §6.1; checkpoint 2 = step 6
(`RawStream`) on top. The checks of §6.1 run at both. **Fallback:** a diff at checkpoint 2 only
→ the package is re-cut to steps 1-5, `main` ~730 (the T7 and ESP32 branches stay in it), an
S33 waiver recorded in the LEDGER, and step 6 is "not queued" until a package has a reason to
move it (D-SLOT's fix is the candidate; `RawStream` is Tier 0 code, so D47's collaborator
admission rule does not bind it, but a move with a reason is still the only way it leaves). A
diff at checkpoint 1 → the package stops and reports. **The compare is never loosened** to admit
a diff.

Rejected, with the reason kept so a later package does not reintroduce it:

- **B — a `CalibrationService` class owning the locals and the loop.** The reviewed note
  rejected it because "a reordered member changes `stack.txt`'s startup lines"; that claim is
  **false** (verdict fact 1): `service_run.py:134-148` runs the service with `stdout=cal.log,
  stderr=STDOUT`, `:245` drops `cal.log` from the listing, `golden/stack.txt` has 0 `[Cal`/
  `[Calibration` lines in 42,382, and lifecycle reads only `Elodin|subscrib` (`lifecycle.py:890`)
  and two shutdown strings (`:1438-1440`). The order is still behaviour (AGENT-RULES 4); its
  guard is the new `cal.log` golden (§7.2), under every design. B lost on S34's letter ("a new
  class"), D45 (recorded lost) and D47 (an owner object enters only in the fix package whose fix
  is its reason to exist): a 30-member owner minted in a move-only pass has no such reason. Its
  one real gain — moved bodies dim under `--color-moved` with no `ctx.` prefix — is matched by
  the prefix-strip check of §6.1. Adopted from B: the `cal.log` golden and the constructor-effect
  audit (`config::load` prints only in its `catch`es, `Config.cpp:442-456`;
  `PTCalibrationManager(false)` skips the load, `PTCalibration.cpp:88-92`; both stores store a
  path, `CubicCalibrationStore.cpp:32-34`, `LcTareStore.cpp:35`; `ElodinClient()` is a
  `make_unique`, `ElodinClient.cpp:10-12`; `load_active_boards`/`load_pt_boards` call `load`,
  `LoadActiveBoards.cpp:12-19`).
- **C — one `static` header of the 209 pure lines (263-278, 331-457, 464-477, 479-530), nothing
  else moved.** WP9 is the split to ~430 (D39); C leaves ~1,900. Its by-construction float proof
  covers exactly the lines §6.3's table already shows non-fusable, while the fusable code (Blend
  300, the smoother sequences 1870-1879 and 2000-2015) stays in `main` and C's own plan queues
  steps 2-6 later with the same gates. `static` in a header is a hazard from step 3 on (≥ 3
  includers): GCC's `-Wunused-function` fires on an unused header `static` in every including TU,
  and `baseline_warnings.txt` is clang/macOS only (D4). Adopted from C: the two GCC inlining
  mechanisms (§6.3), which made the censuses necessary; the cleanup deletions with proofs (§6.2);
  the prerequisite ledger stated as five packages (§7.2).
- **The stage pipeline** (`PacketSource → Decoder → Converter → Publisher`): a rewrite of the
  float path the LEDGER WP9 row protects, for interfaces with one implementation each.

**Boundary with WP8.** WP8 pass 1 adopts seven services, not this one: the signal handler and
install (459-462, 656-657), argv parsing (597-617) and the Elodin connect/register/subscribe/
reconnect/refusal-retry code (1477-1548, 1565-1609) are still hand-written here when WP9 starts.
Move-only does not touch them; cleanup C1 adopts the stop handlers only (DESIGN-WP8 §0 rejects a
shared argv parser and a generic `SubscriberLoop`).

## 1. Baseline (what the code does today)

### 1.1 Responsibilities by line range

| lines | what | notes |
|---|---|---|
| 1-71 | file doc, includes | `<deque>` 35 and `<mutex>` 41 are dead (the include is each one's only hit) |
| 73-154 | anonymous-namespace globals (§1.2); `static std::atomic<bool> running{true}` 154 | `running` is written by the signal handler |
| 156-261 | `verbose()`, `env_flag_true()` (`getenv` per call); PT/LC model enum parse/lookup/name helpers (defaults: full scale 1000, sense resistor 120, LC Linear) | read globals |
| 263-278 | `convert_ratiometric_pt_to_pressure` | pure |
| 280-309 | `select_pt_psi` | reads `g_env_override`, `g_pt_model`; **the Blend arithmetic** (300) |
| 311-329 | `select_lc_kg` | reads `g_lc_model` |
| 331-395 | `convert_hp_pt_to_pressure` | `getenv("CAL_HP_MA_HYST")` per call; mutates the caller's hysteresis latch |
| 397-457 | `convert_tc_adc_to_temp_c`, `clamp_tc_rtd_temp_publish_c`, `convert_rtd_adc_to_temp_c`, `convert_act_adc_to_current`, `convert_lc_adc_to_force` | pure (call lib `type_k_c_from_mv`, `rtd::rtd_board_adc_to_temp_c`) |
| 459-462 | `signalHandler` | prints from the handler (BLOAT-MAP defect 6, kept) |
| 464-477 | `unix_now`, `mono_ns` | the comment at 464-466 belongs to `mono_ns` (S38: moves with it) |
| 479-530 | `resolve_pt_sensor_uid`, `resolve_lc_sensor_uid` | identical bodies, deliberately duplicated (505-509) |
| 532-594 | `kMinAbortCalPoints`, `invert_abort_psi_to_adc` | bisection over the streaming forward model (`select_pt_psi` at 578) |
| 596-617 | `main`: defaults + argv | `--help` exits 0 before anything else |
| 619-651 | adjustments-path discovery | `CAL_BACKUP_PATH`, else newest `calibration_backups/calibration_backup_*.json` |
| 653-657 | banner, signal install | |
| 659-702 | config load, PT/TC/RTD/LC manager construction + loads, counts printed | |
| 704-762 | active boards, PT board configs, HP slot prints, `[calibration.*]` defaults + prints | lambdas `or_default` 661, `boards_of` 709, `current_loop_board` 727-732 (called at 1070, 1973 only) |
| 764-879 | env override (773-778), PT (780-830) and LC (832-879) per-sensor models/params into globals | |
| 881-911 | T7 map (889), T7 config errors (890-893), T7 models into globals (894-911) | |
| 913-921 | `uid_role` (ordered, T7 excluded) | main local |
| 927-992 | cubic store, tare store, capture window; channel registration (PT, LC, T7) | fills `g_lc_uids`, `g_lc_board_ids` |
| 994-1259 | capture/clear lambdas (§1.3) | capture main locals by reference |
| 1261-1283 | seed live store from `cubic_calibration.default.json` | |
| 1285-1391 | `reload_live_store` lambda | ends `write_abort_thresholds()` then `recompute_all_tares()` (1385-1389) |
| 1393-1475 | startup prints, **tare load (1404) before first reload (1410)**, stale-tare audit, `cubic_store.save()`, model summaries (1436-1472) | ordering is load-bearing |
| 1477-1548 | Elodin client, `register_calibrated` (1484), `raw_tables`, `subscribe_all`, `connect_and_register`; `return 1` on failure (1544-1545) | stays in `main` |
| 1550-1562 | loop state: `pkt_buf[65536]` 1556, `packet_count` 1557, unused `logged_ch5` 1558 (`baseline_warnings.txt:7`), **`last_save = steady_clock::now()` 1559**, `last_adc_map` 1560, `command_dedupe` 1562 | `last_save` is taken *after* `connect_and_register` |
| 1564-1609 | loop head: reconnect (2 s sleep), refused-subscription retry, read, ErrorResponse | stays in `main` |
| 1611-1627 | header bytes `[4]`,`[5]`,`[6]`; type filter; first-10 debug log (`static int debug_limit` 1621) | |
| 1629-1821 | `0x46` CalibrationCommand handler, cmd 0-8 | |
| 1823-1911 | LabJack T7 raw (`type_hi == 0x26`) | |
| 1913-1968 | ESP32 raw filter + 21-byte payload decode | `static int ch_mismatch_warn` 1951 |
| 1970-2114 | ESP32 publish: PT 0x20, TC 0x21, RTD 0x22, LC 0x23, ACT 0x30→0x31, ball valve | one `begin_batch`/`flush_batch` |
| 2116-2127 | count log every 10000; 5-min robust auto-save (`> 300` s at 2124) | **only reached on the ESP32 path** |
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
`logged_ch5` (1558, unused).

### 1.3 The lambdas and what they capture

All `[&]` over `main`'s frame. Captured locals: `cal_cfg`, `pt_calibration`, `robust_manager`,
`lc_calibration`, `t7_map`, `uid_role`, `adjustments_path`, `cubic_store`, `lc_tare_store`,
`capture_window`, `pt_board_configs` (through `current_loop_board`), `lc_sensitivity_mv_per_v`,
`lc_pga_gain`, `lc_full_scale_value`, plus the globals.

Lambdas and lines: `sample_robust_curve` 999-1020 (`predict_pressure_psi` ×41 at 1016);
`write_abort_thresholds` 1032-1108 (`invert_abort_psi_to_adc`; `abort_thresholds.txt` via `.tmp`
+ rename); `apply_pt_capture` 1110-1125 (store add/fit → `pt_calibration` → robust update → fit
curve → `cubic_store.save` → `save_adjustments` → `write_abort_thresholds`); `lc_eval_for`
1130-1156 (returns a `std::function` capturing `[&, uid]`); `recompute_tare`,
`recompute_all_tares` 1164-1175 (the tare store, under its mutex, calls the evaluator);
`apply_lc_capture` 1178-1187; `take_capture`, `capture_detail` 1194-1211 (`mono_ns()`);
`is_lc_uid`, `apply_capture` 1216-1225; `apply_pt_clear`, `apply_lc_clear`, `apply_clear`
1228-1259; `reload_live_store` 1294-1391 (ends `write_abort_thresholds()` then
`recompute_all_tares()`); `register_calibrated`, `raw_tables`, `subscribe_all`,
`connect_and_register` 1483-1542 (Elodin; stay in `main`); `publish` (T7) 1851-1856.

### 1.4 Threads, mutexes, lock order

- **One thread.** `main` runs everything; no `std::thread` here or in any lib object it uses.
  `<thread>` is included for `sleep_for`; `<mutex>` and `<deque>` for nothing.
- Mutexes exist only inside lib objects, taken per call, uncontended:
  `CubicCalibrationStore::mutex_`, `LcTareStore::mutex_`, `RobustCalibrationManager::mutex_`,
  `ElodinClient::publish_mutex_`.
- **The one nesting:** `LcTareStore::{set,recompute,recompute_all,recompute_stale}` hold
  `LcTareStore::mutex_` while invoking the evaluator from `lc_eval_for` (`LcTareStore.cpp`
  60-142). The evaluator touches only `lc_calibration` and `t7_map` (no mutex). Order:
  `LcTareStore::mutex_` → nothing. An evaluator that reached into `lc_tare_store` or
  `cubic_store` would self-deadlock or invert an order; its body moves verbatim.
- The signal handler races `std::cout` with the main thread (kept). `running` is checked only at
  the loop head; shutdown latency ≤ the 1 s recv timeout, or ≤ 2 s inside the reconnect sleep.

## 2. Target TUs

| file | contents (moved verbatim) | public interface | users |
|---|---|---|---|
| `Conversions.hpp` | 263-278, 331-457, 464-477 (the 464-466 comment with `mono_ns`), 479-530 | `inline` `convert_ratiometric_pt_to_pressure`, `convert_hp_pt_to_pressure`, `convert_tc_adc_to_temp_c`, `clamp_tc_rtd_temp_publish_c`, `convert_rtd_adc_to_temp_c`, `convert_act_adc_to_current`, `convert_lc_adc_to_force`, `unix_now`, `mono_ns`, `resolve_pt_sensor_uid`, `resolve_lc_sensor_uid`; `kRatiometricPtZeroFrac/SpanFrac` | RawStream, AbortThresholds, CalibrationActions |
| `SensorModels.hpp` / `.cpp` | enums 91, 127; globals 80-150 except the three stream globals (`extern` in the header, defined in the `.cpp`); 156-261 and 286-329 header-`inline`; 773-879 → `load_pt_lc_models(cfg)`; 894-911 → `load_t7_models(cfg, t7_map)` (889-893 stay in `main` between them); 943-992 → `register_store_channels(cubic_store, pt_boards, lc_boards, t7_map)`; 1436-1472 → `print_model_summary()` | the above | main, RawStream, AbortThresholds, CalibrationActions, CalibrationCommands |
| `CalibrationContext.hpp` | `struct CalibrationContext` (§3): references only, no methods | the struct | CalibrationActions, AbortThresholds, CalibrationCommands, RawStream |
| `CalibrationActions.hpp` / `.cpp` | 727-732 (`current_loop_board`, now `const PtBoardConfig* current_loop_board(const CalibrationContext&, uint8_t)`), 999-1259, 1294-1391 → free functions in the same textual order | `sample_robust_curve`, `lc_eval_for`, `recompute_tare`, `recompute_all_tares`, `take_capture`, `capture_detail` (no context), `is_lc_uid`, `apply_capture`, `apply_clear`, `reload_live_store`, `current_loop_board` (also used at 1973); `apply_pt_*`/`apply_lc_*` file-`static` | main, CalibrationCommands, AbortThresholds, RawStream |
| `AbortThresholds.hpp` / `.cpp` | 532-594 file-`static`; 1032-1108 | `void write_abort_thresholds(CalibrationContext&)` | CalibrationActions (capture, clear, reload) |
| `CalibrationCommands.hpp` / `.cpp` | 1631-1819 (inside `if (type_hi == 0x46)`) | `void handle_calibration_command(CalibrationContext&, fsw::calibration::CommandDedupe&, const uint8_t* pkt_buf, ssize_t pkt_len)` | main loop |
| `RawStream.hpp` / `.cpp` | 1827-1910, 1913-2127; `g_hp_ma_live`, `g_pt_smoother`, `g_t7_cold_junction_c` in `RawStream.cpp`'s anonymous namespace | `struct StreamState`; `handle_t7_raw(CalibrationContext&, StreamState&, const uint8_t*, ssize_t, uint8_t type_lo)`; `handle_esp32_raw(…, uint8_t type_hi, uint8_t type_lo)` | main loop |
| `calibration_main.cpp` | keeps 1-71 (trimmed includes), 154, 459-462, 596-760, 889-893, 913-938, 1261-1283, 1393-1435 with calls in place of moved bodies, 1474-1627, the three dispatches, 2130-2139 | `main` | — |

Why none of this is a single-user abstraction (S34, D43(3)): the files are translation units.
`CalibrationContext` and `StreamState` are method-less carriers of `main`'s existing locals; the
functions that replace the lambdas live in four TUs and read the same locals those lambdas
captured. `Conversions.hpp` and `SensorModels.hpp` each have ≥ 3 including TUs.
`CalibrationContext` gets its own header because four headers take it; in `CalibrationActions.hpp`
it would make `AbortThresholds.hpp` include the whole actions API for one type while
`CalibrationActions.cpp` includes `AbortThresholds.hpp` back. `table_id_for` (DESIGN-WP3 §2.5) is
not adopted: calibration derives `cal_lo = type_lo + 0x10` (1966-1968) and the slot by the inverse
(490, 517); neither is the same integer expression.

Declaration-only stubs, clang-format 19 clean, in `docs/remaster/design-stubs/cpp/services/
calibration/`: `Conversions.hpp`, `SensorModels.hpp`, `CalibrationContext.hpp`,
`CalibrationActions.hpp`, `AbortThresholds.hpp`, `CalibrationCommands.hpp`, `RawStream.hpp`
(`on_elodin_reconnected` marked cleanup-only). Frozen once step 1 starts.

## 3. Ownership and data flow

`main` owns every object, constructed in today's order at today's line positions (construction
has side effects: `load_calibration` prints, constructors register paths, the fills print counts).
Immediately after the last `register_store_channels` call (old 992), before the seed block, `main`
builds:

```cpp
// CalibrationContext.hpp
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

After `connect_and_register` and the recv timeout, at old 1557's position, `main`
aggregate-initialises `StreamState` (RawStream.hpp): references to `elodin_client`,
`tc_calibration`, `rtd_calibration`, `pt_boards`, `lc_boards`; copies of the const doubles
`tc_adc_ref_voltage`, `rtd_adc_ref_voltage`, `rtd_excitation_ua`, `rtd_r0_ohm`; the owned loop
locals `int packet_count = 0`, `int debug_limit = 0` (the function-static of 1621, now a member:
same single counter, same zero start, `main` runs once), `last_save`, `last_adc_map`.
**`last_save` is written with `std::chrono::steady_clock::now()` in that initialiser** (or by an
assignment immediately after it): today's `auto last_save = steady_clock::now()` at 1559 runs
*after* `connect_and_register` (1544), and a bare `time_point` member is the epoch, so the first
ESP32 packet would satisfy `> 300` s at 2124 and save. `command_dedupe` stays a `main` local
passed to the command handler; `pkt_buf` and `logged_ch5` stay in `main` (the baseline warning
stays attributed to this file). On reconnect (1564-1578), the clear at 1575 becomes
**`stream.last_adc_map.clear();`**, after `capture_window.clear()` (1574) and before `[Cal]
Reconnected to Elodin`, both in `main`'s loop head; cleanup C2 gives the clear to RawStream
(`on_elodin_reconnected(StreamState&)`, same point) because in move-only two modules write
RawStream's state — accepted for the pass, fixed by a one-call-site move (D43(3)).

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

Mutex ownership is unchanged (§1.4): no new mutex, no new thread. Every evaluator returned by
`lc_eval_for` captures `CalibrationContext&` and `uid`; `LcTareStore` uses evaluators only for
the duration of the call (`const Evaluator&`; it stores only the numeric fingerprint), and the
context lives in `main`'s frame for the process lifetime.

## 4. Error handling today, kept identical

No exceptions are caught in `main` except the `directory_iterator` scan (645); everything else
that throws terminates (SIGABRT). The split adds no `try`/`catch` and removes none.

| condition | today | where |
|---|---|---|
| `--help`/`-h` | usage line (no `--adjustments` in it) to stdout, `return 0`, nothing else runs | 612-616 |
| bad `--elodin-port` | `atoi` → `uint16_t` wrap, no message | 609 |
| unknown arg / flag without value | ignored silently | 602-617 |
| signal before 656 | default action (exit by signal) | |
| missing/malformed config | `fsw::config::load` logs (`Config.cpp:447`, `:453`), defaults (C2-4) | 660 |
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
| SIGPIPE (Elodin closes during a send) | **default: process dies**; systemd `Restart=always` | no handler; the transport sends without `MSG_NOSIGNAL` |
| SIGINT/SIGTERM | handler prints `\n[CalibrationService] Caught signal, shutting down...`, `running=false`; loop exits; `Saved robust adjustments on shutdown → …` if saved; `cubic_store.save()`; `[Cal] Stopped.`; exit 0 | 459-462, 2130-2138 |

**CalibrationCommand has no reply.** Nothing is sent back on `0x46`; a command's observable
effects are the files it writes, the values published afterwards and its log lines.

How it stays identical: every branch moves with its body. **Only the `continue`s of the outer
read loop that sit inside moved code become `return`**, exactly these: **1637, 1829, 1838, 1841,
1845, 1910, 1915, 1922, 1924, 1930, 1939**. The handler call is the last statement of its branch
in `main`, followed by `continue`, so control reaches the same next statement. **1673, 1789 and
1796 are `continue`s of inner `for` loops inside the 0x46 handler: they stay `continue`.** 1601,
1608, 1617 (loop head) and 1820 (after the 0x46 dispatch) stay in `main` as `continue`.

**1673 and 1796 are unexercised by today's `stack.txt`.** `burst()`
(`service_run.py:430-446`) ticks 10 s and sends 10 fresh samples per uid in `every` (`:509-518`)
before cmd 0 and cmd 8, so the refused-capture branches inside Zero All and Tare All never fire;
1789 **is** exercised (`clearing = ref_val >= 0.5f`; the harness sends `cmd(8, 0, 1.0)`, `:522`).
A wrongly `return`ed 1673 or 1796 would pass today's golden — the stale-uid C0 case (§7.2) gates
step 5 for that reason.

The specific traps: 1820 (after the whole `0x46` block, also when `pkt_len < 24`) stays in
main as `if (type_hi == 0x46) { handle_calibration_command(...); continue; }`; the T7 early
`continue`s (1829, 1838, 1841, 1845, before `begin_batch`) and 1910 become `return` in
`handle_t7_raw`; the ESP32 filter 1913-1940 moves into `handle_esp32_raw` (its `continue`s →
`return`, before `begin_batch`) and so do 2116-2127, so the count log and the auto-save still run
only after an ESP32 packet; the `debug_limit` check at 1621-1627 stays in main's loop head and
reads `stream.debug_limit`, as 1935-1938 does.

## 5. Naming

Files `PascalCase.{hpp,cpp}` as in `services/sequencer/` and `lib/`; `calibration_main.cpp` keeps
its name. Moved functions keep their names exactly (grep anchors; S7); lambdas become functions
of the same name. New names: `CalibrationContext`, `StreamState`, `load_pt_lc_models`,
`load_t7_models`, `register_store_channels`, `print_model_summary`, `handle_calibration_command`,
`handle_t7_raw`, `handle_esp32_raw`, and in cleanup `on_elodin_reconnected`, `pt_cal_status`,
`board_number_from_uid`. No `Manager`, `Controller` or `Registry`.

## 6. The passes

### 6.1 Move-only pass (one queue item, two checkpoints; D12(e), D49(10))

Rule: cut and paste. Allowed edits are only: `static` → `inline` for functions moved into a
header; `static` kept for functions that stay TU-private; lambda → function signature with the
captured locals reached through `ctx.`/`st.`/`stream.`; `continue` → `return` as listed in §4;
added `#include`s, namespace wrappers and `using` declarations; the `CalibrationContext` and
`StreamState` initialisers of §3. No expression, literal, string, loop or statement order changes. No reformatting beyond what
clang-format 19 does to the moved text (include regrouping and rewraps are expected non-dimmed
lines, D43(6)).

**Before step 1, on the unchanged tree** (Release, under the stack lock, per leg — macOS and the
Linux arm64 gcc-12 container):

```
bash daq-server/test/characterization/with_stack_lock.sh \
  python3 daq-server/test/characterization/calibration/service_run.py \
    --cal daq-server/build-gate/bin/calibration_service \
    --fixtures daq-server/test/characterization/calibration/fixtures > /tmp/wp9-pre-1.txt
# keep each run's <work>/cal.log beside its output (/tmp/wp9-pre-1.cal.log);
# a second time, same binary → /tmp/wp9-pre-2.txt; the Linux leg likewise, twice:
bash daq-server/test/characterization/linux/linux_gate.sh --areas calibration <rev>
grep -o '"\([^"\\]\|\\.\)*"' .../calibration_main.cpp | sort > /tmp/wp9-literals-pre.txt
grep -oE '[0-9]+\.[0-9]+([eE][-+]?[0-9]+)?' .../calibration_main.cpp | sort > /tmp/wp9-floats-pre.txt
nm -C --undefined-only calibration_service | sort > /tmp/wp9-undef-pre.txt
nm -C --defined-only calibration_service | sort > /tmp/wp9-def-pre.txt
objdump -d calibration_service > /tmp/wp9-asm-pre.txt
```

**Pre/pre first** (verdict fact 9). Byte-identity of `service_run.py`'s output pre/post was
assumed unconditionally; it is not proven feasible: `adj.json` carries `theta_mean`/`theta_cov`
at full precision (`stack.txt:7357+`), the normaliser masks only timestamps and `fitCurve[].psi`
(`service_run.py:264-290`), and the robust path has a wall-clock input upstream of the θ update
(`RobustCalibrationFramework.cpp:326-333` propagates the bias by steady-clock dt; `:377-386`
folds `bias_contribution()` into the residual before the Bayesian update). So the two pre runs
per leg are diffed first; **every field they disagree on is masked**, and the mask is listed in
the merge row (expected: at most `adj.json` θ/cov — published values are deterministic, no
fixture role streams `robust`). Everything else is `cmp` byte-identical pre/post. The mask is
derived from the unchanged binary, never from a post diff. This Mac's `build/` is -O0 and is not
evidence; the goldens' 4 ULP is the gate's floor, the masked `cmp` is the package's.

Steps (each compiles; commit per step):

1. **`Conversions.hpp`** (§2 row 1): `static` → `inline` (≥ 3 includers from step 3; a header
   `static` would draw GCC's `-Wunused-function` in every including TU on the Linux leg; the
   inline-budget change this makes is what the censuses watch). Includes: `<algorithm> <array>
   <chrono> <cmath> <cstdint> <cstdlib> <vector>`, `"calibration/SensorCalibration.hpp"`,
   `"calibration/TypeK.hpp"`, `"config/LoadActiveBoards.hpp"`, `"elodin/DatabaseConfig.hpp"`. In
   `calibration_main.cpp`, `#include "Conversions.hpp"` and `using namespace
   fsw::calibration_service;` after the includes.
2. **`SensorModels.hpp/.cpp`** (§2 row 2; gated by G1 — line 300 moves here — and by the `cal.log`
   golden — the fills and the summary print): the `extern` globals keep their types and
   initialisers (default-constructed, no cross-TU init dependency, nothing reads them before
   `main`; S26); `verbose`, `env_flag_true` go header-inline with the helpers; **889-893 stay in
   `main` between `load_pt_lc_models` and `load_t7_models`**; the T7 count print 910-911 goes
   with `load_t7_models`.
3. **`CalibrationContext.hpp` + `CalibrationActions.hpp/.cpp`** (§2 rows 3-4; gated by
   tares-before-reload and G5 — 1294-1391 moves here): the struct of §3, built in `main`
   immediately after the last `register_store_channels` call (old 992), before the seed block;
   the functions in **the same textual order** as today; `capture_detail` takes no context;
   `lc_eval_for` returns `[&ctx, uid](double adc) -> double {…}` with the body verbatim.
4. **`AbortThresholds.hpp/.cpp`** (§2 row 5). `CalibrationActions.cpp` includes its header.
5. **`CalibrationCommands.hpp/.cpp`** (§2 row 6; gated by the stale-uid case — 1673/1796 move
   here): the `continue` at 1637 → `return`; 1673, 1789, 1796 stay `continue`. **→ Checkpoint 1:
   every check below.**
6. **`RawStream.hpp/.cpp`** (§2 row 7): `static int ch_mismatch_warn` stays function-local in
   `handle_esp32_raw`; the `reinterpret_cast` loads at 1944, 1960, 1961 are unchanged (same
   alignment: the buffer is still `main`'s stack array); `main` initialises `StreamState` at old
   1557 with `last_save{steady_clock::now()}` (§3). **→ Checkpoint 2: every check below.**
7. **`calibration_main.cpp`** keeps §2's list. Order of calls in `main`, which **must equal
   today's order of side effects**: argv → adjustments discovery → banner → `std::signal` ×2 →
   config load → managers + loads + 4 prints → active boards → pt board configs → HP prints →
   defaults prints → `load_pt_lc_models` → `t7_map` + T7 errors → `load_t7_models` → `uid_role`
   → stores + capture window → `register_store_channels` → `CalibrationContext` → seed copy →
   adjustments path prints → **`lc_tare_store.load()`** → **`reload_live_store(ctx, true)`** →
   stale audit → `cubic_store.save()` → `print_model_summary()` → verbose line → Elodin client,
   lambdas, `connect_and_register` / `return 1` → recv timeout → `StreamState` → loop → shutdown.
8. **CMake** (`services/CMakeLists.txt:45`):
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
   gets. `lib/CMakeLists.txt` is not touched. Root `format.sh` (orchestrator-owned): check that
   `services/calibration/*.{hpp,cpp}` are matched; ask if not.
9. Format only the touched files with the pinned clang-format 19.1.7.

**Checks at each checkpoint, all required** (both legs: macOS Release and Linux arm64 gcc-12
Release; the lib is `SHARED` (`lib/CMakeLists.txt:45`) and the service is one TU today
(`services/CMakeLists.txt:45`), so every service-binary census covers exactly the moved code):

- **(a) `cmp`.** `service_run.py`'s output **and** the run's `cal.log` (which `:245` excludes
  from that output; normalised by the C0 package's normaliser — timestamps, the Elodin port),
  post on the same machine and the same leg, masked by the pre/pre mask only, both `cmp`
  byte-identical with the pre run. The `cal.log` half is the one guard on startup print order.
- **(b) Per-symbol FMA census.** `objdump -d` split on `<…>:`, then
  `grep -cE 'fmadd|fmsub|fnmadd|fnmsub|fmla|fmls'` per symbol that contains moved code: equal
  pre/post. A total count can stay equal while a fusion moves between symbols; per symbol it
  cannot.
- **(c) Defined-symbol census.** `nm -C --defined-only` filtered to the moved function names,
  compared **demangled and unqualified**: pre they are `_ZL…` (`t`, file-local), post
  `fsw::calibration_service::…` (`W`, inline with an out-of-line copy). The *set* of moved
  functions that have an out-of-line copy must match pre/post; the kind change `t` → `W` is
  accepted. This is where C's two inlining mechanisms (§6.3) would show.
- **(d) External calls.** `nm -C --undefined-only | sort` identical (no lib function newly called
  or dropped: no math moved across the lib boundary).
- **(e) Literal multisets.** Concatenate the new files and `calibration_main.cpp`, extract string
  literals as above, sort, `diff` with `/tmp/wp9-literals-pre.txt`: identical (every log line,
  path and key moved unchanged). Floating literals likewise.
- **(f) Warnings.** `calibration_main.cpp: unused variable 'logged_ch5'` still present
  (`baseline_warnings.txt:7`), nothing new, on both legs.
- **(g) Lib diff empty.** `git diff --stat backend-remastered...HEAD -- diablo_server/lib`.
- **(h) Prefix-strip moved-code diff.** In a scratch copy, `sed -E -i 's/\b(ctx|st|stream)\.//g'`
  over the new TUs and `calibration_main.cpp`, then `git diff -M --color-moved=dimmed-zebra
  --color-moved-ws=allow-indentation-change backend-remastered...HEAD --
  diablo_server/services/calibration`. Every line **not** dimmed must be one of: an `#include`; a
  namespace line; `static` → `inline`; a function signature replacing a lambda head (15 heads, 3
  handler signatures) or a `{`/`}` closing it; one of the 11 `continue` → `return` lines (§4); the
  `StreamState`/`CalibrationContext` initialisers; CMake; clang-format's regrouping. Any other
  non-dimmed line is a review stop. The ~126 prefixed lines (60 actions, 13 commands, 53 stream)
  are thereby a script result, not a reading task.
- **(i) Goldens.** Both goldens (`stack.txt`, `lib.txt`) on both legs, plus the `-O0` rebuild
  (`-DCMAKE_BUILD_TYPE=` empty) run once on macOS (D22's one-golden-for-every-build rule), plus
  the calibration area on the emulated amd64 gcc-12 leg (`CHAR_EMULATED=1`, as C3 ran it, D28;
  D55 keeps calibration in that leg's scope; native amd64 is CI's). A red `robust-prediction` or
  `published-*` family is a contract change until proven otherwise: stop and report.

**Fallback** (§0): a diff at checkpoint 2 only → re-cut to steps 1-5, `main` ~730, S33 waiver in
the LEDGER (orchestrator), step 6 not queued; a diff at checkpoint 1 → the package stops. The
compare is never loosened; the mask is never widened after the pre/pre run.

### 6.2 Cleanup pass (separate queue item, each item its own commit, each gated by §7)

- **C1 adopt WP8's stop handlers** (DESIGN-WP8 §2.1; after DESIGN-WP8 gap 1 is merged):
  `installStopHandlers(kPrintThenStop, "\n[CalibrationService] Caught signal, shutting down...",
  Sigpipe::kDefault)` — print the exact line, then clear the flag; **SIGPIPE: default (no
  `SIG_IGN`)**; installed at the same point (after the banner, before config load); every read of
  `running` → `fsw::service::running()`. Not WP8 helpers, kept verbatim through both passes: the
  argv loop (defaults `config/config.toml`, `127.0.0.1`, `2240`,
  `scripts/calibration/calibrations/adjustments.json`, which the discovery at 619-651 compares
  against; §4's first three rows) and the Elodin loop (§4's connect, subscribe, disconnect and
  ErrorResponse rows; registration and subscription order frozen by the elodin schema golden).
- **C2 globals out**: the `SensorModels` globals become one `SensorModels` value owned by `main`
  and referenced from `CalibrationContext`; the RawStream globals move into `StreamState`;
  helpers take it explicitly. The reconnect clear becomes `on_elodin_reconnected(StreamState&)`
  in `RawStream.cpp`, called at the same point of `main`'s loop head. Behaviour identical (no
  reader before `main`).
- **C3 two duplicates with two users each**: `pt_cal_status(model, fac_ok, has_rob)` for
  1871-1878 / 2004-2011 (identical modulo indentation; proof: `stack.txt` `cal_status` exact);
  `board_number_from_uid(uid)` for 1067-1069 / 1142-1144 (integer). Both integer-only; neither
  touches the Blend → smoother sequence's arithmetic, but C3 edits the D22 TU, so checks (a)-(d)
  run on it too.
- **C's deletions**, each its own commit with its proof: dead `#include <deque>` (35) and
  `<mutex>` (41), the include being each one's only hit — proof: build, `nm -C --undefined-only`
  identical. `logged_ch5` (1558) plus `baseline_warnings.txt:7` is the orchestrator's decision
  (D4; open question 5): if deleted, the warnings diff must be that line only.
- **Not in cleanup** (behaviour, contract or arithmetic risk; parked or left): merging
  `resolve_pt_sensor_uid`/`resolve_lc_sensor_uid` (identical bodies, callers 1975/2073; the
  comment at 505-509 gives a blast-radius reason; open question 2, team's call); replacing header
  bytes `[4..7]` with `elodin::PacketHeader` (DESIGN-WP8 §0 decided against it); any change to the
  defects (signal-handler I/O, 2 s uninterruptible sleep, SIGPIPE, C3-1, C6-9).

### 6.3 Arithmetic: what moves, what must not

`calculate_pressure` and the robust path **do not live in this file and WP9 does not move them**:

| function | defined | reached from calibration_main via |
|---|---|---|
| `PTCalibrationCoeffs::calculate_pressure` (`A*x*x*x + B*x*x + C*x + D`) | `lib/include/calibration/PTCalibration.hpp:34-37`, header-inline | only through `PTCalibrationManager::calculate_pressure` (`lib/src/calibration/PTCalibration.cpp:313-322`, out of line) |
| `RobustCalibrationManager::predict_pressure_psi` | `lib/src/calibration/RobustCalibrationManager.cpp:185-191` | 577, 1016, 1865, 1991 |
| `RobustCalibrationFramework::predict_pressure_psi` | `lib/src/calibration/RobustCalibrationFramework.cpp:364` | via the manager |
| `SensorCalibrationManager::calculate` | `lib/src/calibration/SensorCalibration.cpp` | LC/TC/RTD |

Both are compiled in lib TUs, out of line from the service; `lib/` is untouched (check (g)).
That is how WP9 meets the LEDGER WP9 row: the robust path and `calculate_pressure` keep their
arithmetic order because WP9 does not touch them.

Floating-point arithmetic that does move (inside `calibration_service`):

| expression | where | contractible to FMA? |
|---|---|---|
| `(1.0 - kFactoryWeight) * psi_rob + kFactoryWeight * psi_fac` | `select_pt_psi` 300 (Blend) | **yes** (mul + add) |
| `alpha_ * value + (1.0 - alpha_) * it->second` | `PtSmoother::step`, `PtSmoothing.hpp:30`, lib header-inline, inlined at 1879, 2015 | **yes** |
| `(frac - z) / s * fs` | ratiometric 274 | no (sub, div, mul) |
| `(adc/MAX)*ref`, `(v/r)*1000`, `((i-4)/16)*fs`, `4 + hyst`, `4 - min(…)` | HP 353-391 | no |
| `(adc/MAX)*ref`, `*1000` | TC 405-406 | no |
| `(adc/4095)*3.3` | ACT 440 | no |
| `(s/1000)*g*2^31`, `(adc/code_fs)*fs` | LC 453-456 | no |
| `amin + (amax - amin) * i / kSamples` | `sample_robust_curve` 1014 | no (division between) |
| bisection | 585-592 | integer |

Neither the CMake tree nor `scripts/build.sh` sets `-ffp-contract` (grep of every
`CMakeLists.txt`; only `-Wall …` and sanitizer flags). Defaults apply: clang `-ffp-contract=on`
(within one expression), GCC `-ffp-contract=fast` (`-std=gnu++20` from CMake's default
`CMAKE_CXX_EXTENSIONS`; can contract across statements after inlining). Build types: gate and
Linux leg `Release`; CI `Release`, `Debug`, `RelWithDebInfo`; `flake.nix` `Release`;
`scripts/build.sh` sets none (no `-O`). **Bound.** The Blend result is `value`, a *multiplicand*
in `step` (`alpha_ * value + …`); the sequence 1870→1879 and 2000→2015 has only integer
`cal_status` statements between. No `a*b+c` spans the two statements, so no new contraction can
appear from the move; what can change is *whether* a `convert_*`/`select_*` body is inlined.

**The two GCC mechanisms (C, verdict fact 6).** (a) `static` → `inline` moves a function from
the `max-inline-insns-auto` budget to `max-inline-insns-single`; (b) growth into a very large
caller is throttled, and the callers shrink from a ~1,540-line `main` to a 215-line and an
84-line handler. GCC 12 `params.opt`: `max-inline-insns-single` Init(70),
`max-inline-insns-auto` Init(15), `large-function-insns` 2700, `large-function-growth` 100 %
(the single = declared-inline / auto = the rest scoping is the manual's `--param` prose; verify
on the leg with `g++-12 -O2 -Q --help=params`). Both change which `convert_*`/`select_*` inlines
on gcc-12, not the expression trees. **The censuses (b)-(d) of §6.1, not this table, are the
evidence**: the defined-symbol census sees a body gaining or losing its out-of-line copy, the
per-symbol FMA census sees a contraction appearing or vanishing, and the masked `cmp` sees the
value.

Where the two contractible expressions stay: `select_pt_psi` header-`inline` (never out of line
in another TU, never in the lib), still inlined into `handle_t7_raw`, `handle_esp32_raw` and the
bisection's forward lambda (565-578), its three call sites today; `PtSmoother::step` in the same
statement sequence in the same function body (now `handle_*_raw`), in a TU built with the same
flags. **Coverage:** the Blend expression is in no golden today; G1 (§7.2) closes before step 2
with a reseed case such that changing `kFactoryWeight` 0.25 → 0.75 (line 299) goes red.

## 7. Guarding characterization

### 7.1 Coverage per part

| part | guarded by | notes |
|---|---|---|
| conversions, model selection, cal_status | `calibration/golden/stack.txt` (published float32 at 4 ULP; `published-near-zero` abs 1e-12) | `fixtures/stack_config.toml`: cubic + physics ratiometric PTs, 4-20 mA PTs (hysteresis, per-role full scale and shunt), LC linear/cubic/physics, TC poly + physics, RTD, ACT incl. offsets 0x0B/0x0F, ball valve, T7 PT/TC/RTD/LC/cubic PT |
| abort thresholds | `stack.txt` snapshots of `abort_thresholds.txt` (cubic, physics, loop, sparse fallback, T7 rejection, unknown role); `generated_unix` normalised | |
| captures, clears, zero/zero-all, tares, reload (cmd 7), dedupe, refused captures, unknown cmd 9, uid 9999 | `stack.txt` published frames + snapshots of cubic store, `lc_tare.json`, `adj.json` (robust parameters rel 1e-2) | `fitCurve[].psi` masked (C3-1); **not** the refused branches inside Zero All / Tare All (§4) |
| seed from `cubic_calibration.default.json`; tare-before-reload ordering | `stack.txt` "after startup" (`:681`) and "after restart" snapshots | the ordering mistake is visible only if the restart's curve differs from the one the tare was taken on — hence §7.2's package |
| startup print order | **nothing today** (verdict fact 1): `cal.log` is not in any golden | §7.2's `cal.log` golden |
| SIGTERM exit code, restart | `stack.txt` `service exit code 0`; lifecycle `shutdown.txt`: exit 0 within [0, 3.5] s, `'Saved robust adjustments on shutdown' logged`, `'[Cal] Stopped.' logged`, adjustments written; SIGINT alone: exit 0 within [0, 4] s | log lines tests read: exactly those two (`lifecycle.py:1438-1440`) plus `wait_log(r"Elodin\|subscrib")` on startup (`:890`) |
| registration + subscription order and bytes | elodin `## calibration` section (`schema_config_base.txt`, `schema_profile_default.txt`) and `stack.txt` startup frames | C1 is on the tip |
| T7 end to end, restart, re-subscribe after late T7 registration | ctest `t7_integration` (RUN_SERIAL, 180 s) | `timing_ctests.txt`; judged on the Linux leg / CI (D31, D34) |
| robust streaming end to end | integration `cal_robust_learn` (`"Ox Upstream" = "robust"`; asserts > 15 psi move) | loose; the orchestrator's gate |
| lib math (`calculate_pressure`, robust predictions at abs 1e-9) | `calibration/golden/lib.txt` | `lib/` unchanged; still re-run (lib headers inline into moved code) |

White-box hooks: **none for this file.** `calibration/README.md` and
`calibration/CMakeLists.txt:22` state that `calibration_main.cpp` is reached only through the
built binary; `config/char_config_services.cpp` includes the daq_bridge, stacklight and
config_broadcast mains, not this one. WP9 re-points no harness file.

### 7.2 C0 prerequisites (five test-only packages; all gate checkpoint 1)

All five are test-only, D32-batchable (`calibration/` only), start now in parallel with WP8, and
each is tied to the step that moves the line it guards. Each is proven by its mutation going red
before it is trusted (AGENT-RULES: a test that cannot fail is not a test).

| package | guards | moved by | the case |
|---|---|---|---|
| **`cal.log` golden + pre/post `cmp`** | startup print order; 1404 before 1410 (`LC tare: resumed` before `Cubic: resumed`) | steps 2-3 | `cal.log` normalised (timestamps, the Elodin port masked), frozen as a golden; **one malformed-config run** so `Config.cpp:447`'s `[Config] TOML parse error` line has a position to hold; the move-only package also `cmp`s pre/post `cal.log` per leg |
| **stale-uid Zero All / Tare All** | 1673, 1796 stay `continue` | step 5 | cmd 0 and cmd 8 with one uid whose last sample is stale: the refused uid is logged `REJECTED` and the loop goes on to the next uid; a `return` there skips the rest and goes red |
| **tares-before-reload** | 1404 → 1410 | step 3 | run the mutation "`lc_tare_store.load()` after the first `reload_live_store()`" against `stack.txt`; if it stays green, add a "profile swapped on disk while the service is down, then start" case whose restart curve differs from the tare's |
| **G5 Elodin down at start (C6-9)** | 1385-1389 (the reload tail that writes the two files), 1544 | step 3 | exit code 1, with `abort_thresholds.txt` and the cubic store written first, and no `adj.json` |
| **G1 Blend reseed** | line 300 | step 2 | a Blend role whose published value is frozen after a reseed with no learning (Robust values are wall-clock dependent, C3-1: freeze `cal_status`, the frame set, and Blend/Robust values only where `has_robust` is false or after the reseed; mask the rest as `fitCurve` is masked); mutation `kFactoryWeight` 0.25 → 0.75 (299) goes red |

G1 is the expensive one. If it alone is not green when the other four are, the orchestrator may
run WP10 first and queue WP9 after it (Prerequisites).

### 7.3 Other gaps (accepted; worth writing, not gating)

**G2** env overrides `CAL_USE_FACTORY_PT` / `CAL_USE_ROBUST_BLEND` / `CAL_USE_ROBUST_PT`
(precedence 773-778, summary line 1436-1441, abort model 1073), `CAL_HP_MA_HYST=0`. **G3**
reconnect: the stand-in drops the connection; expect re-registration, re-subscription, and a
capture right after reconnect REJECTED. **G4** refusal retry in the stack: one ErrorResponse,
expect a re-subscribe of exactly that table ~1 s later (today only `t7_integration` part 4).
**G6** CLI: `--help` text and exit 0; adjustments discovery (the harness always passes
`--adjustments`). **G7** SIGPIPE: DESIGN-WP8 gap 1 (`kill -PIPE`; calibration exits −13), before
cleanup C1. **G8** 5-minute auto-save: not practical to freeze (300 s); a review item (the tail of
`handle_esp32_raw` and the `last_save` initialiser of §3). **G9** debug-limit/log text: not read
by any test; held by the literal multiset (e) and, from §7.2 on, the `cal.log` golden.

## 8. Risks

- **Order of side effects at startup.** The trap the reviewed note named worst, and nothing
  froze it until §7.2's `cal.log` golden. Build the context struct from references to locals
  constructed at today's positions; never let a struct constructor own and construct them. Tare
  load before first reload (1404 → 1410) is asserted by the code's own audit log (1424-1429), the
  `cal.log` golden and the tares-before-reload package.
- **`last_save`.** A bare `StreamState` member is the epoch and the first ESP32 packet saves
  (§3). The initialiser at old 1557 is a permitted non-dimmed line; it is checked by reading.
- **Hidden control flow in the loop.** The `continue` → `return` mapping (§4); 1673/1796
  unexercised today; the auto-save only after ESP32 packets; the shared `debug_limit`.
- **Arithmetic.** §6.3. The risky moves — `select_pt_psi` or the stream branches into the shared
  `-fPIC` lib, or `select_pt_psi` into a separate `.cpp` out of line — are excluded. Inlining on
  gcc-12 can still change; the censuses see it and the fallback is the answer, never a loosened
  compare. Byte identity was over-claimed before: the pre/pre mask (§6.1) is how the `cmp` stays
  honest — a field that differs between two runs of the same binary is masked before, not after.
- **Concurrency and static init.** Single thread; no new thread (forbidden), lock order unchanged
  (§1.4), evaluator body verbatim. Globals go from internal to external linkage in move-only (C2
  removes them); default-constructed containers, no dynamic-init dependency on another TU.
- **Warnings baseline.** `logged_ch5` stays in `calibration_main.cpp` or the warning moves to
  another file and the gate reads it as new + missing; `inline`, not `static`, in headers keeps
  the Linux leg's warning set unchanged.
- **macOS timer (D34).** The calibration area has no tight timing bound (lifecycle's 3.5 s / 4 s
  exit bounds are far above the 1 s recv timeout + 2 s reconnect sleep). `t7_integration` touches
  this binary: judge it on the Linux leg and CI; if it needs a retry there, run it 10× alone on
  the WP tip and on the pre-WP tip and compare pass rates (D31).

## Open items

Closed by the verdict: question 1 (the two carriers `CalibrationContext`, `StreamState` stand;
A′ over B and C), question 3 (tares-before-reload is a C0 gate), question 4 (the < 400 DoD is
waived; no C1b).

Team questions (verdict §5):

1. Open questions 2 (`resolve_*` merge: identical bodies, 505-509 says the copy was deliberate;
   behaviour-neutral) and 5 (`logged_ch5` + its `baseline_warnings.txt:7` line: delete in cleanup
   or keep?).
2. Should the `cal.log` golden also freeze the `[Calibration]` count lines nothing reads?
3. Should `adj.json`'s θ/cov be masked permanently in the stack golden (rel 1e-2, no contract;
   the predictions carry it), once the pre/pre run shows the spread?
4. C6-9's inverse (startup retry, S11) and D-SLOT's fix are fix packages with their own goldens,
   not WP9's.

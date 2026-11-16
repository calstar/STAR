# DESIGN-WP3 — C++ library hygiene

Target-design note for WP3 (BLOAT-MAP WP3 row, §2c, §2e), written before any code moves (D17a).
Design only: nothing here changes a golden. Line numbers are `backend-remastered` @ b2599617
(product code = `main` @ 15b5a0c5). WP3 runs **after WP2** (`wp/WP2-dead-cpp` @ 4cc0b2e4), so the
tree it starts from is WP2's: `archive/legacy/utl/` holds only `db.hpp`; `Messages.hpp`,
`transport/test/**` and the other `utl/*.hpp` are gone; `lib/CMakeLists.txt` lines after 41 move up
by one (WP2 drops the `IMUCalibration` comment). Re-anchor with the `grep -n` anchors given below;
names, not numbers, are the contract. Paths are relative to `daq-server/diablo_server/` unless they
start with `test/`, `archive/`, `githooks/` or `docs/`.

**Prerequisites:** WP2 merged; C1 (`packets/`, `elodin/`) merged (its `comms_messages.cpp` and the
Elodin schema goldens are this package's guards).

Rules applied: D4 (warning baseline), D5 (contract frozen: the Elodin schema bytes), D12(e)/D17
(move first; no single-user abstraction; per-caller behaviour kept), D18/D20 (harness), D22 (no
float arithmetic moves here), AGENT-RULES 4-6.

## 0. Summary

Inputs beyond the reviewed notes: `docs/remaster/research/subscription-robustness.md` (Idea 1:
one pure table-id function so a later D-SLOT fix is one clause), LEDGER D42 (binding: "one pure
`tableIdFor()` and a single `registerAllTables()`"; the second half was dropped by D49(10)), and `STYLE.md` (branch `design/style` @
fc425dce; cited as `STYLE-S<n>`).

WP3 does five things, each a separate commit:

1. **Delete `PressureStateMachine`** (`lib/src/control/PressureStateMachine.cpp` 771,
   `lib/include/control/PressureStateMachine.hpp` 246): compiled into `fsw_daq_lib`, zero callers.
   **`ControlMessages.hpp` is kept** (divergence from BLOAT-MAP, §1.3).
2. **Move `archive/legacy/utl/db.hpp` → `lib/third_party/elodin/db.hpp`**, byte for byte, and make
   its include directory a **`SYSTEM PRIVATE`** property of `fsw_daq_lib` (it is today `SYSTEM
   PUBLIC` on the lib and plain on every service through `COMMON_INCLUDES`).
3. **One `send_msg`**: `lib/src/elodin/SendMsg.hpp`, a private lib header with two users
   (`DatabaseConfig.cpp`, `ControllerService.cpp`), carrying the one behavioural difference between
   the two copies as a parameter.
4. **Move the canonical printer** out of `Parser.cpp` (824-931) into `lib/src/script/Printer.cpp`.
5. **One pure table-id function**, `fsw::elodin::table_id_for` (the `tableIdFor()` of D42, spelled
   snake_case per STYLE-S1 because it lands in `lib/include/elodin/`), replacing the 15 copies of
   `static_cast<uint8_t>((board_number - 1) * 0x20 [+ 0x10] + ch)` in `DatabaseConfig.cpp` and the
   3 in `T7Stream.cpp`/`SensorTables.cpp`, wrap included (§2.5).

Not done (divergence from BLOAT-MAP, §1.3): splitting `DatabaseConfig.cpp` by family. The research
attached `tableIdFor` to that split; it does not need it (§2.5).

Net: about **−1,020** lines (PSM) and **0** behaviour change; `archive/` no longer holds a compiled
header.

## 1. Alternatives considered

### 1.1 The three designs

| | A. BLOAT-MAP as written | **B. Encoder as a lib-private detail (chosen)** | C. Facade over db.hpp |
|---|---|---|---|
| PSM | delete PSM **and** `ControlMessages.hpp` | delete PSM; keep `ControlMessages.hpp` | delete PSM; keep `ControlMessages.hpp` |
| db.hpp | `lib/third_party/elodin/`, include dir as today (`SYSTEM PUBLIC` on the lib, plain on services) | same file move; include dir `SYSTEM PRIVATE` on `fsw_daq_lib`, dropped from `services/CMakeLists.txt` `COMMON_INCLUDES` | a new `elodin/Schema.{hpp,cpp}` wrapping the builder DSL (`vtable`, `raw_field`, `schema`, `component`, `set_component_name`, `set_entity_name`) so one TU includes db.hpp; `DatabaseConfig` and `ControllerService` re-expressed through it |
| `send_msg` | `lib/include/elodin/SendMsg.hpp`, public | `lib/src/elodin/SendMsg.hpp`, lib-private (needs db.hpp, which only the lib sees) | absorbed into the facade |
| Parser | `Printer.cpp` | `Printer.cpp` | `Printer.cpp` |
| DatabaseConfig | split per family (+ an internal header for the four shared static helpers); `tableIdFor` in the split's internal header (research Idea 1's placement) | not split; `table_id_for` in a public `lib/include/elodin/TableId.hpp`, adopted by every lib registrar/list | rewritten against the facade; table ids inside it |

### 1.2 Comparison

| criterion | A | B | C |
|---|---|---|---|
| clarity | per-family files are easy to find; the shared helpers need a new internal header, so a family file is not self-contained | the one thing that is not ours (db.hpp) is visibly third-party and visible only where it is used (3 → 2 TUs); everything else stays where a reader expects it | best on paper (one TU knows postcard), but the facade must mirror the builder DSL one-for-one (every `PrimType`, `raw_field` offset, `component` name), so it is db.hpp's API again under a new name |
| lines deleted | ~1,020 (PSM) + 53 (`ControlMessages.hpp`), minus ~40 for the split's headers/includes | ~1,020 | ~1,020 minus the facade (~150) |
| testability | unchanged (black-box goldens) | unchanged | unchanged; nothing new becomes testable white-box (D20 keeps goldens black-box anyway) |
| D-SLOT readiness (research subscription-robustness Idea 1) | one clause, but only if the split's internal header is also used by `T7Stream.cpp`/`SensorTables.cpp` (other dirs) — so it would have to be public anyway | one clause in `table_id_for` covers every lib registrar (daq_bridge's and calibration_service's registrations both go through `DatabaseConfig`, t7's through `T7Stream`); the service-side publishers adopt in WP9/WP10 cleanup | the facade is the one place, but at the cost of the rewrite |
| fit with characterization | **breaks C1**: `queue/C1` `packets/comms_messages.cpp:40` includes `ControlMessages.hpp` and `:248` dumps `control::ControlStateMessage` into `packets/golden/comms_messages.txt`. Deleting it is a compile failure and, if the test is edited, removed golden lines (AGENT-RULES 5, D20) | every guard compiles unchanged; the Elodin schema goldens are black-box (real binaries against a stand-in elodin-db), so a moved header is invisible to them | same guards, but every registration byte stream is produced by new code: `elodin/golden/schema_*.txt` is the only proof, and it covers start-up only (DESIGN-WP10 §7.4 gap 1) |
| float-path risk (D22) | none (integer/byte encoding only) | none | none |
| thread/lock risk | none | none | none (registration runs on whichever thread calls it today; unchanged) |
| warning baseline (D4) | split TUs re-include db.hpp from new files: fine if the dir stays SYSTEM | db.hpp stays reached only through a SYSTEM dir: the baseline has **no** db.hpp line today and gets none | a facade TU is fine; but any accidental include from a non-lib target would surface db.hpp's `-Wmissing-field-initializers` |
| diff size / review | large (split + header) | small; db.hpp is `git diff -M100%` | very large, all of it in the contract's encoding path |

### 1.3 Why A lost

- `ControlMessages.hpp` is no longer dead: the packets characterization freezes its
  `CommsMessage` aliases (WP2-EVIDENCE "Kept although listed as a candidate"). Deleting it needs a
  C0 test change that removes golden lines; that is a contract decision, not hygiene. With PSM gone
  the header is kept alive **only** by that golden: recorded in §8 as an open question for C0 / the
  team, not acted on.
- The `DatabaseConfig.cpp` split (712 lines, 12 over the god-file line) deletes nothing. The four
  file-static helpers (`send_msg`, `register_raw_sensor_vtable`, `register_calibrated_vtable`,
  `register_actuator_state_vtable`, plus the anonymous `appendTables`, `register_t7_vtable`) are
  shared across families, so a split must first promote them to an internal header — a new
  internal interface whose only purpose is to make the split possible. The file is one concern
  (Elodin schema registration), ordered by family already, with `// ──` banners per family. D17(d)
  and "slim, not reshuffle" both say leave it.

### 1.4 Why C lost

It rewrites the bytes the Elodin contract freezes (D5) to gain an abstraction with two users that
re-exports the abstraction it hides. The goldens would catch a wrong byte at start-up but not on
re-registration (WP10 gap 1). Move-only hygiene must not be the package that rewrites the encoder.

### 1.5 Divergences from BLOAT-MAP's WP3 row (BLOAT-MAP is a draft, not a reviewed note)

| BLOAT-MAP | this note | why |
|---|---|---|
| delete `ControlMessages.hpp` "with PressureStateMachine" | keep | C1's `comms_messages.cpp` freezes it (above) |
| split `DatabaseConfig.cpp` by family | not split | §1.3 |
| `lib/include/elodin/SendMsg.hpp` | `lib/src/elodin/SendMsg.hpp` | it includes db.hpp, which becomes lib-private; a public header that drags a private include path would fail to compile for any non-lib includer |
| (unspecified) db.hpp's include path | `SYSTEM PRIVATE` on `fsw_daq_lib`; removed from `COMMON_INCLUDES` | only three lib `.cpp` files include db.hpp (two after PSM): `DatabaseConfig.cpp:7`, `ControllerService.cpp:31`, `PressureStateMachine.cpp:14`. No header, service source or harness includes it (grep of `diablo_server`, `test/`, `queue/C1`), so nothing outside the lib needs the path |

## 2. The design

### 2.1 PressureStateMachine

Delete `lib/src/control/PressureStateMachine.cpp`, `lib/include/control/PressureStateMachine.hpp`,
and the `src/control/PressureStateMachine.cpp` line in `lib/CMakeLists.txt` `FSW_SOURCES`
(anchor `grep -n PressureStateMachine lib/CMakeLists.txt`). Evidence it is dead: no
`#include "control/PressureStateMachine.hpp"` outside its own `.cpp`; the only other mentions are
comments (`services/sequencer/PressureFeed.cpp:160`,
`transport/include/comms/messages/control/ControllerMessages.hpp:71`) and
`archive/legacy/cpp/sitl/**` (deleted by WP2). No test target lists the file.

Observable effect: `fsw_daq_lib`'s exported symbol set shrinks by PSM's members. No binary, test or
harness references them, the TU has no namespace-scope object with dynamic initialisation (so no
start-up side effect disappears), and nothing outside the build reads the export table.

The two comments that name PSM stay in the deletion commit as they are (`PressureFeed.cpp:160`
explains a historical layout bug; changing it is WP12's or cleanup's, not a deletion's).
`ControllerMessages.hpp:71` ("Written by PressureStateMachine …") becomes false; fixing a comment
in a header the packets golden compiles is harmless but is still a separate one-line commit
(§5 step 5) so the deletion stays a pure deletion.

### 2.2 db.hpp

`git mv archive/legacy/utl/db.hpp diablo_server/lib/third_party/elodin/db.hpp` — content unchanged
(`git diff -M100% --stat` shows a pure rename). Constraints that fix the destination:

- **SYSTEM directory, or the baseline breaks.** `lib/CMakeLists.txt:55-61` reaches db.hpp only
  through a `SYSTEM` include directory, so its `-Wmissing-field-initializers` (every one left in the
  tree, per that comment) are not reported; `baseline_warnings.txt` has no db.hpp line. A
  destination on a plain include path (`lib/include/elodin/`, or `lib/src/elodin/` next to its
  includer — a quoted include searches the includer's directory first and that is not a system
  directory) would add those warnings → red under D4. Editing db.hpp to add a pragma is forbidden
  (byte-identical move).
- **The basename stays `db.hpp`.** db.hpp:4515-4517 does `#if __has_include("db.hpp") #include
  "db.hpp"` (its second half includes its first through the include guard). The quoted lookup
  resolves in db.hpp's own directory first; renaming the file breaks it.
- **Includers do not change.** `DatabaseConfig.cpp:7` and `ControllerService.cpp:31` keep
  `#include "db.hpp"`: not found beside the includer (`lib/src/elodin/`, `lib/src/control/`), not on
  `lib/include`, `lib/src`, `transport/include`, then found on the SYSTEM directory, as today.

`lib/CMakeLists.txt` after the change (replacing the block at 55-61; comment kept, path updated):

```cmake
# SYSTEM so the vendored Elodin encoder (third_party/elodin/db.hpp) does not report warnings we are
# not going to act on — db.hpp alone accounts for every -Wmissing-field-initializers left in the
# tree. PRIVATE: only fsw_daq_lib's own sources include it (DatabaseConfig.cpp, ControllerService.cpp).
target_include_directories(fsw_daq_lib SYSTEM PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/elodin
)
```

`services/CMakeLists.txt:7`: delete the `archive/legacy/utl` line from `COMMON_INCLUDES`.

Why PRIVATE is not a behaviour change: the property only decides which compile lines carry
`-isystem …/utl`. Every target other than `fsw_daq_lib` loses that flag; none of their sources
includes `db.hpp` or any header that does, and after WP2 the directory holds no other file a
`#include` could resolve to. Codegen of those TUs is unchanged; the build proves it (no new warning,
no missing include).

References outside WP3's files, by owner (all must be updated or confirmed, none silently left):

| reference | owner | action |
|---|---|---|
| `lib/CMakeLists.txt:55-61`, `services/CMakeLists.txt:7` | WP3 | as above |
| `githooks/pre-push:22,26` (`git diff --quiet HEAD -- … daq-server/archive/legacy/utl …`) | WP3 (under `daq-server/`) | replace the path with nothing: `daq-server/diablo_server` already covers `lib/third_party/` |
| `test/characterization/config/CMakeLists.txt:10` (`_CFG_INCLUDES`) | C0 (harness) | **redundant today**: its targets link `fsw_daq_lib` (whose SYSTEM PUBLIC path propagates now) and none of the three mains it includes, nor `char_config_dump`'s sources, includes db.hpp. After the move the line names a directory that no longer exists; `-I`/`-isystem` of a missing directory is not an error and `-Wmissing-include-dirs` is not in `-Wall -Wextra -Wpedantic`. WP3 does **not** edit it (no D18 need); the orchestrator removes it in a C0 commit. The WP3 build is the check that it is harmless |
| `test/characterization/gate.sh:118-119` (`git ls-files … 'daq-server/archive/legacy/utl'` for format_check) | C0 | an empty pathspec match is not an error; db.hpp is still format-checked because `daq-server/diablo_server` now contains it (it is clang-format-19 clean today). Orchestrator drops the path |
| root `format.sh:28` `TARGETS` | orchestrator | replace with nothing (covered by `daq-server/diablo_server`) — check that `format.sh` does not exclude `third_party` |
| `.github/workflows/daq-server-ci.yml:227` ccache key | orchestrator | drop the two `archive/legacy/utl` globs; the key goes cold once (harmless) |
| `.github/workflows/daq-server-ci.yml:303,325,383,397` (TODO / `#include <iostream>` / secrets / unsafe-function greps) | orchestrator | drop `archive/legacy/utl/` (a missing path makes `grep -r` print an error and, at 325, can change the `if` status); db.hpp is still scanned under `diablo_server/` |

### 2.3 One `send_msg`

The two live copies (PSM's lambda at `PressureStateMachine.cpp:733-738` dies with PSM):

| | `DatabaseConfig.cpp:16-24` | `ControllerService.cpp:921-927` |
|---|---|---|
| namespace | `fsw::elodin`, file `static` | `fsw::control`, file `static` |
| encode | `Msg(msg).encode_vec()` | same |
| empty buffer | `std::cerr << "[DatabaseConfig] Failed to encode message" << std::endl;` then `return false` | `return false`, silent |
| send | `client.send_msg({0, 0}, buf)` | same |

Encode failure is practically unreachable (`encode_vec` sizes the buffer with `encoded_size()`
first) and no black-box test can provoke it, but D17 is statement for statement: the shared function
takes the failure text, `nullptr` meaning silent. Two users, two values: not a single-user knob.

```cpp
// lib/src/elodin/SendMsg.hpp (stub: docs/remaster/design-stubs/cpp/lib/src/elodin/SendMsg.hpp)
namespace fsw::elodin {
template <typename T>
inline bool send_msg(ElodinClient& client, T msg, const char* encode_failure_line);
}
```

`DatabaseConfig.cpp` (56 calls): delete 15-24, `#include "elodin/SendMsg.hpp"`, and give every call the text.
To keep the 56 call sites a one-token change, a file-static forwarding overload is **not** added
(it would be a second `send_msg` again); instead each call becomes
`send_msg(client, X, kEncodeFailed)` with `static constexpr const char kEncodeFailed[] =
"[DatabaseConfig] Failed to encode message";` at the top of the file. `ControllerService.cpp`:
delete 921-927, include the header, the 15 calls become `fsw::elodin::send_msg(*elodin_client_, X,
nullptr)` (qualified: `ControllerService.cpp` is in `fsw::control`; ADL on `ElodinClient` would
find it too, but the qualification says where it lives).

`#include "db.hpp"` stays in both `.cpp` files as well (they use the builder DSL directly);
`SendMsg.hpp` includes it itself so it is self-contained.

**For WP10** (DESIGN-WP10 §3.3 "if WP3 has already replaced `send_msg`… the include moves"): the
include to move into `ControllerService_elodin.cpp` is `#include "elodin/SendMsg.hpp"`; the calls
are `fsw::elodin::send_msg(*elodin_client_, …, nullptr)`; `#include "db.hpp"` and the two
`using namespace vtable…` lines move with `registerControllerTables`.

### 2.4 Printer

Cut `Parser.cpp` 824-931 (the `// Canonical printer` banner, the anonymous namespace with
`printExpr`, `printBlock` forward declaration, `printStmt`, `printBlock`, and `print_canonical`) into
`lib/src/script/Printer.cpp`:

```cpp
#include <string>

#include "script/StateScript.hpp"

namespace fsw {
namespace script {
// … moved text, unchanged …
}  // namespace script
}  // namespace fsw
```

It needs only public names: `op_name` (`StateScript.hpp:119`), the AST types, and
`print_canonical`'s declaration (`StateScript.hpp:289`). No new header. Append
`src/script/Printer.cpp` after `src/script/Parser.cpp` in `FSW_SOURCES`. Same directory convention
as `Lexer.cpp`/`Parser.cpp`/`Validate.cpp`/`Slug.cpp`: one stage per TU.

The move is proven self-contained by the build: any reference from the printer block into
`Parser.cpp`'s first anonymous namespace (126-811) would be an undefined name or a link error in
`Printer.cpp`, never a silent change.

D22: `printExpr`'s `std::to_string(e.number)` is formatting, not arithmetic; no expression is
contractible. The printer has no callers inside `Parser.cpp` (anonymous-namespace helpers used only
by `print_canonical`), so `Parser.cpp` keeps no unused static (`-Wunused-function` would otherwise
trip D4).

### 2.5 One table-id function (`table_id_for`)

D42 makes this binding; the research's argument (subscription-robustness Idea 1) is that the
table id `(slot-1)*0x20 [+0x10] + ch` is computed in many places, wraps silently in a `uint8_t`
for slot > 8 (D-SLOT: slot 10 lands on PT2.CH1), and a later fail-closed check must have exactly one
place to go. Today's copies in the lib (integer-only, so D22 does not apply):

| site | expression | half |
|---|---|---|
| `DatabaseConfig.cpp` `appendTables` (165-171) | `(board.board_number - 1) * 0x20 + offset + ch` (offset 0x00 / 0x10) | both (lists for subscribers: `raw_sensor_tables`, `calibrated_sensor_tables`, `ball_valve_*_tables`) |
| `DatabaseConfig.cpp` `register_tables` (256-350), 6 families | `(board.board_number - 1) * 0x20 + ch` | raw |
| `DatabaseConfig.cpp` `register_calibrated_tables` (356-442), 6 families | `… * 0x20 + 0x10 + ch` | calibrated |
| `DatabaseConfig.cpp` `register_ball_valve_{,calibrated_,cmd_}tables` (620-665) | same, 3 sites | raw, calibrated, raw |
| `t7/T7Stream.cpp:22-24, 30-32` `table_id`, `calibrated_table_id` | `(slot - 1) * 0x20 [+ 0x10] + ain` | both |
| `config/SensorTables.cpp:23` `makeRef` | `(r.board_number - 1) * 0x20 + 0x10 + channel` (`channel` is `int`) | calibrated |

```cpp
// lib/include/elodin/TableId.hpp (stub: docs/remaster/design-stubs/cpp/lib/include/elodin/TableId.hpp)
namespace fsw::elodin {
enum class TableHalf : uint8_t { kRaw = 0x00, kCalibrated = 0x10 };
constexpr std::pair<uint8_t, uint8_t> table_id_for(uint8_t type_hi, uint8_t slot, uint8_t channel,
                                                   TableHalf half) noexcept;
}
```

Body, the one expression: `{type_hi, static_cast<uint8_t>((slot - 1) * 0x20 +
static_cast<uint8_t>(half) + channel)}`. Integer promotion makes every operand `int`, the sum is
reduced mod 256 by the cast, exactly as each copy does today. `SensorTables.cpp` passes an `int`
channel: converting it to `uint8_t` before the addition gives the same result mod 256 (C++20
defines the conversion as modular), so the bytes cannot differ for any input.

Decisions, each a divergence from the research's sketch (`tableIdFor(family, slot, ch,
calibrated) -> std::optional<std::pair<…>>`):

- **`type_hi`, not a family enum.** The families *are* the high bytes (0x20 PT … 0x24 ENC, 0x30 ACT
  raw / 0x31 calibrated, 0x33/0x34/0x35 ball valve, 0x26 T7). An enum would be a second table to
  keep in step with the first.
- **A plain pair, not `std::optional`.** An optional that is always engaged gives every caller a
  branch no input can take (untestable code, and STYLE-S34's "a knob every caller passes the same
  value is a constant"). The D-SLOT fix changes the return type, and the compiler then lists every
  caller that must decide what a refused id means. That is the "one clause" plus a checked list.
- **Name.** `table_id_for` per STYLE-S1 (`lib/include/elodin` is 0:36 camel:snake; D43(2)).
- **Not adopted in WP3:** `T7Calibration.cpp:34` (`+ kCjcTableOffset`, not a channel: it would
  pass a constant as `channel`, which reads wrong) and every service-side copy — `daq_bridge`'s
  publish base, `ActuatorCommander.cpp:36-41` `actuator_elodin_low_byte`, `ControllerService.cpp:773`
  (`base` without the channel), `calibration_main.cpp:1965ff` and the inverse at 490/517. They belong
  to WP9/WP10, which may adopt `table_id_for` in their cleanup passes only where the integer
  expression is the same; DESIGN-WP9/WP10's amendments list them.

The slot rule itself (`board_id % 10`, 0 → 10) has its own copies (`CubicCalibrationStore.cpp:26`,
`LcTareStore.cpp:30`, `actuator_elodin_low_byte`, `calibration_main.cpp:497/524`,
`BoardConfig::slot()`); not WP3's (it is not a table id), recorded for the team beside D-SLOT.

Guard: the Elodin schema goldens print every registered `(hi, lo)` and entity name for
`config_base` and `profile_default`; `pipeline/` and `t7_integration` exercise T7Stream's ids;
`config/golden/cpp/config/*` prints the `PtRoleRef` table bytes `SensorTables.cpp` derives.
Mutation: make `table_id_for` add `0x11` instead of `0x10` → calibrated lines in `schema_*.txt` go
red; revert. **The wrap itself needs its own guard.** Today the D41 fixture (board 60 → slot 10 →
`0x31`) exercises it in `pipeline/`, but H2 (`fix/H2-startup-board-slot`, queued ahead of every WP)
frees slot 10 and fails the harness on `[Config] ERROR`, after which no black-box run can configure
slot > 8. So WP3 adds a small ctest on the pure function (D20 permits white-box for pure functions
with stable signatures): `table_id_for(0x20, 10, 1, kCalibrated) == {0x20, 0x31}` (the wrap),
`table_id_for(0x20, 1, 1, kRaw) == {0x20, 0x01}` and `(0x20, 2, 1, kCalibrated) == {0x20, 0x31}`
(the collision D-SLOT names). Mutation: saturate at 0xFF instead of wrapping → red. Optional second
layer (research subscription-robustness Idea 1): a characterization test that enumerates the shipped
profiles' slots and asserts the id map is injective, red on `config_base` + board 60.

`TableHalf::kRaw` (offset 0x00) is also what command tables use (`ball_valve_cmd_tables`, ACT_CMD
0x32): integer-identical, but "raw" is a misnomer there; the WP10 adoption list says so.

### 2.6 Interfaces (stubs)

New headers, as declaration-only stubs with ownership/threading/error/must-not-know comments
(STYLE-S36), under `docs/remaster/design-stubs/cpp/` (not built, in no CMake target):

| stub | becomes | users |
|---|---|---|
| `lib/src/elodin/SendMsg.hpp` | `diablo_server/lib/src/elodin/SendMsg.hpp` | `DatabaseConfig.cpp`, `ControllerService.cpp` (→ `ControllerService_elodin.cpp` in WP10) |
| `lib/include/elodin/TableId.hpp` | `diablo_server/lib/include/elodin/TableId.hpp` | `DatabaseConfig.cpp`, `T7Stream.cpp`, `SensorTables.cpp`; later WP9/WP10 cleanups |

`db.hpp` is moved, not new (no stub); `Printer.cpp` needs no header (`StateScript.hpp:289`
already declares `print_canonical`).

## 3. Ownership and data flow

Nothing changes hands. `fsw_daq_lib` owns the Elodin encoder after WP3 as it does today, but now
says so in its CMake. `DatabaseConfig` owns the shared-table schema; `ControllerService` owns the
controller tables ([0x40]–[0x44]); both encode through `send_msg`, which owns nothing (a function
template; the caller owns the client and the message). No thread, lock or lifetime moves. The
canonical printer remains a pure function of a `ScriptProgram`.

## 4. Error handling

| path | today | after |
|---|---|---|
| encode failure, DatabaseConfig | one cerr line, `false` | identical (text passed in) |
| encode failure, controller | `false`, silent | identical (`nullptr`) |
| `client.send_msg` failure | its return value | identical |
| a target that newly needs db.hpp | — | compile error "db.hpp not found" (by design: link through `fsw_daq_lib`'s sources, or make the path PUBLIC in its own commit) |

## 5. Passes (one package; WP3 is hygiene, not a god-file split, so no separate cleanup item)

One commit each, in this order, each built and guarded:

1. Delete PSM (`.cpp`, `.hpp`, CMake line).
2. `git mv` db.hpp; `lib/CMakeLists.txt` SYSTEM PRIVATE block; `services/CMakeLists.txt`
   `COMMON_INCLUDES`; `githooks/pre-push`. Hand the orchestrator its four lines (§2.2 table).
3. `SendMsg.hpp`; adopt in `DatabaseConfig.cpp` and `ControllerService.cpp`.
4. `Printer.cpp`; `FSW_SOURCES`.
5. `TableId.hpp`; adopt in `DatabaseConfig.cpp` (15 sites + `appendTables`), `T7Stream.cpp`,
   `SensorTables.cpp`, plus the `table_id_for` ctest (`lib/test/test_table_id.cpp`, registered in
   `lib/CMakeLists.txt`, which WP3 owns). One commit; the schema goldens, the ctest and the
   mutations in §2.5 are its proof.
6. Comment fix in `ControllerMessages.hpp:71` (PSM no longer exists): optional, separate
   (STYLE-S38: stale comments are corrected outside a move).

Format only touched files with the pinned clang-format 19.1.7 (db.hpp is not touched; it is
already clean).

## 6. Guarding characterization

| change | guarded by | check |
|---|---|---|
| PSM deletion | build; `packets/comms_messages.cpp` (compiles `ControlMessages.hpp` and `ControllerMessages.hpp`) | `ctest -R char_packets_comms_messages` (no lock needed) |
| db.hpp move | `git diff -M100%` (rename only); clean build with **no new warning** vs `baseline_warnings.txt` (proves the SYSTEM path survived); `elodin/golden/schema_{config_base,profile_default}.txt` (every registration byte from daq_bridge, calibration, sequencer, controller, t7_bridge, heartbeat, stacklight) | `CHAR_AREAS=elodin,packets,config` under the lock |
| `send_msg` | `elodin` section `controller_service` and every `DatabaseConfig` caller section | same run; mutation (proves the guard): pass the wrong component name in one `DatabaseConfig` call → red; revert |
| Printer | `config/golden/cpp/script_parse/*` (canonical print of every script fixture), ctest `state_script` (`lib/test/test_state_script.cpp`), `tools/state_script_check` | `ctest -R 'state_script\|characterization_config_cpp'`; mutation: drop the `.`-trim loop in `printExpr` → `script_parse` lines with `0.5` go red; revert |
| everything | Linux leg `--areas elodin,packets,config` (gcc-12 looks headers up the same way, but SYSTEM handling of `-isystem` vs `-I` is compiler-specific: prove "no new warning" on gcc too) | `linux_gate.sh --areas elodin,packets,config <rev>` |

Gaps: none that WP3 needs closed first. The Elodin re-registration gap (DESIGN-WP10 §7.4 gap 1)
matters only if a later package changes registration code; WP3 moves none of it.

## 7. Risks

- **Include resolution drift.** If any directory earlier on the search path ever gains a file named
  `db.hpp`, it would shadow the vendored one (true today as well). The SYSTEM PRIVATE block names
  the only place it lives.
- **The controller's `send_msg` call sites are in a WP10 file.** WP3 edits
  `ControllerService.cpp` (tokens at the call sites, the include, the deleted template). WP10's
  re-anchoring by function name absorbs it; §2.3 tells WP10 what to move.
- **Warning baseline on gcc.** `baseline_warnings.txt` was taken with clang/macOS. On gcc,
  `-isystem` also demotes warnings; check the Linux leg's warning set does not grow.

## 8. Open questions

1. `ControlMessages.hpp` now exists only because `packets/comms_messages.cpp` freezes it. Keep it
   (this note), or have C0 drop it from the test with the golden lines accounted for (D20)? Team /
   orchestrator.
2. Should the orchestrator remove the now-redundant `_CFG_INCLUDES` line in
   `test/characterization/config/CMakeLists.txt` in the same queue item, or later?
3. Defect candidate (report only): the two `send_msg` copies disagreed on whether an encode failure
   is logged; kept as-is via the parameter.

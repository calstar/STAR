# DESIGN-WP3 — C++ library hygiene

The "as decided" execution note for WP3 (D17(a)): what an implementer does, in what order, and
why. Decisions: D45 (design deepening), D62 (simplicity review round 1). How it got here — the
deepened note with its alternatives A/B/C, the comparison matrix, the dropped `table_id_for`
(§2.5 there) and the closed questions — is preserved verbatim in
[`debates/WP3/history.md`](debates/WP3/history.md). Where the two disagree, this note wins.

**Baseline.** WP3 runs **after WP2**, so product code (`diablo_server/`, `archive/`) is read from
the WP2 tree, `wp/WP2-dead-cpp` @ **`4cc0b2e4`**; everything else (`test/`, `githooks/`, root
`format.sh`, the CI yml, these docs) from `backend-remastered` @ **`3b618ab6`** (whose
`diablo_server/` is `b2599617`'s = `main` @ `15b5a0c5`). Every file WP3 edits is byte-identical on
the two branches except `lib/CMakeLists.txt` (WP2 drops the `IMUCalibration` comment at 42, so
lines after 41 are one lower) and `gate.sh` (`backend-remastered` gained a line at 28 after WP2
branched); where a number differs it is given as **WP2 / BR**. Re-anchor with the `grep -n`
anchors given; names, not numbers, are the contract. Paths are relative to
`daq-server/diablo_server/` unless they start with `test/`, `archive/`, `githooks/`, `docs/` or
`.github/`.

**Prerequisites:** WP2 merged; C1 (`packets/`, `elodin/`) merged (its `comms_messages.cpp` and the
Elodin schema goldens are this package's guards).

**Rules applied:** D4 (warning baseline), D5 (contract frozen: the Elodin schema bytes), D12(e)/D17
(move first; no single-user abstraction; per-caller behaviour kept), D18/D20 (harness), D22 (no
float arithmetic moves here), AGENT-RULES 4-6; STYLE-S1, S12, S33, S34, S36, S38.

## 0. Summary

WP3 does four things, each a separate commit, each built and guarded (D62: "verified
executable"):

1. **Delete `PressureStateMachine`** (`lib/src/control/PressureStateMachine.cpp` 771,
   `lib/include/control/PressureStateMachine.hpp` 246): compiled into `fsw_daq_lib`, zero callers.
   **`ControlMessages.hpp` is kept** (§1).
2. **Move `archive/legacy/utl/db.hpp` → `lib/third_party/elodin/db.hpp`**, byte for byte, and make
   its include directory a **`SYSTEM PRIVATE`** property of `fsw_daq_lib` (today `SYSTEM PUBLIC` on
   the lib and plain on every service through `COMMON_INCLUDES` and on the config harness through
   `_CFG_INCLUDES`).
3. **One `send_msg`**: `lib/src/elodin/SendMsg.hpp`, a lib-private header with two users
   (`DatabaseConfig.cpp`, `ControllerService.cpp`), carrying the one behavioural difference between
   the two copies as a parameter.
4. **Move the canonical printer** out of `Parser.cpp` (824-931) into `lib/src/script/Printer.cpp`.

Plus an optional fifth commit that corrects two comments the moves leave stale (§5).

**Not done:** `table_id_for` (dropped, D62, §2.5); splitting `DatabaseConfig.cpp` by family
(§1); deleting `ControlMessages.hpp` (§1).

Net: **−1017** lines (771 + 246, PSM) and **0** behaviour change; `archive/` no longer holds a
compiled header; WP3 only deletes and moves.

## 1. Divergences from BLOAT-MAP's WP3 row (BLOAT-MAP is a draft, not a reviewed note)

| BLOAT-MAP | this note | why |
|---|---|---|
| delete `ControlMessages.hpp` "with PressureStateMachine" | keep | no longer dead: C1's `packets/comms_messages.cpp:40` includes it and `:248` dumps `control::ControlStateMessage` into `packets/golden/comms_messages.txt`. Deleting it is a compile failure and, if the test is edited, removed golden lines (AGENT-RULES 5, D20). With PSM gone the header is kept alive only by that golden: §8 Q1 |
| split `DatabaseConfig.cpp` by family | not split | 712 lines, 12 over the god-file line, one concern (Elodin schema registration), already ordered by family with `// ──` banners. The file-static helpers (`send_msg`, `register_raw_sensor_vtable`, `register_calibrated_vtable`, `register_actuator_state_vtable`, the anonymous `appendTables`, `register_t7_vtable`) are shared across families, so a split must first promote them to an internal header whose only purpose is to make the split possible. D17(d), "slim, not reshuffle" |
| `lib/include/elodin/SendMsg.hpp` (public) | `lib/src/elodin/SendMsg.hpp` (lib-private) | it includes db.hpp, whose directory becomes `SYSTEM PRIVATE`; a non-lib includer would fail to compile (§2.3) |
| (unspecified) db.hpp's include path | `SYSTEM PRIVATE` on `fsw_daq_lib`; removed from `COMMON_INCLUDES` and `_CFG_INCLUDES` | only three lib `.cpp` files include db.hpp on the WP2 tree (two after PSM): `DatabaseConfig.cpp:7`, `ControllerService.cpp:31`, `PressureStateMachine.cpp:14` (`git grep -n '"db.hpp"' wp/WP2-dead-cpp -- daq-server`). No header, service source or harness includes it, so nothing outside the lib needs the path |
| one `tableIdFor()` (D42 binding 3, via the research) | dropped | D62, §2.5 |

## 2. The design

### 2.1 PressureStateMachine

Delete `lib/src/control/PressureStateMachine.cpp`, `lib/include/control/PressureStateMachine.hpp`,
and the `src/control/PressureStateMachine.cpp` line in `lib/CMakeLists.txt` `FSW_SOURCES` (line 29
on both branches; anchor `grep -n PressureStateMachine lib/CMakeLists.txt`). Evidence it is dead:
no `#include "control/PressureStateMachine.hpp"` outside its own `.cpp`; no test target lists the
file; `archive/legacy/cpp/sitl/**` (its only other user) is deleted by WP2.

Observable effect: `fsw_daq_lib`'s exported symbol set shrinks by PSM's members. No binary, test or
harness references them, the TU has no namespace-scope object with dynamic initialisation (so no
start-up side effect disappears), and nothing outside the build reads the export table.

Every remaining mention of the name is a comment or a document, and none of them is touched by
the deletion commit (a deletion stays a pure deletion):

| mention | what | owner |
|---|---|---|
| `services/sequencer/PressureFeed.cpp:160` | explains a historical layout bug ("PressureStateMachine uses twelve …"); still true as history | stays (WP12 / cleanup, not WP3) |
| `transport/include/comms/messages/control/ControllerMessages.hpp:71` ("Written by PressureStateMachine on every executeStateEntryActions call") | becomes false | WP3's optional comment commit (§5 step 5); the header is compiled by the packets golden, so the fix is harmless but still separate (STYLE-S38) |
| `tools/gui/README.md:122,134`, `tools/gui/combined_fsw_gui.py:98`, `docs/CONTROLLER_STACK_AND_DB_WRITES.md:60`, `docs/IMPROVEMENTS.md:525`, `frontend/components/controls/StateMachineDiagram.tsx:43`, `flash/dependencies.txt:23` | comments and docs that name PSM as the FSW's state machine or as compiled into `libfsw_daq_lib.so` (`flash/dependencies.txt:23` is the one that becomes false) | WP12 |
| `daq-server/build-clang-ci/{build.ninja,.ninja_log,.ninja_deps}` | a **checked-in build directory** (3 tracked files, paths under `/home/aidan/Diablo-FSW/`), not a comment; it names `PressureStateMachine.cpp.o` | not WP3's; reported to the orchestrator (§8 Q3) |

### 2.2 db.hpp

`git mv archive/legacy/utl/db.hpp diablo_server/lib/third_party/elodin/db.hpp` — content unchanged
(`git diff -M100% --stat` shows a pure rename). Constraints that fix the destination:

- **SYSTEM directory, or the baseline breaks.** `lib/CMakeLists.txt` 54-60 / 55-61 reaches db.hpp
  only through a `SYSTEM` include directory, so its `-Wmissing-field-initializers` are not
  reported and `baseline_warnings.txt` has no db.hpp line. A destination on a plain include path
  (`lib/include/elodin/`, or `lib/src/elodin/` next to its includer — a quoted include searches the
  includer's directory first and that is not a system directory) would add those warnings → red
  under D4. Editing db.hpp to add a pragma is forbidden (byte-identical move).
- **The basename stays `db.hpp`.** db.hpp:4515-4516 does `#if __has_include("db.hpp")` /
  `#include "db.hpp"` (`#endif` at 4517): its second half includes its first through the include
  guard. The quoted lookup resolves in db.hpp's own directory first; renaming the file breaks it.
  Its other probe, `#if __has_include("postcard.h")` (db.hpp:13), is false in both directories (no
  `postcard.h` anywhere in the tree: `git ls-tree -r --name-only wp/WP2-dead-cpp | grep -i
  postcard` is empty), so the preprocessed text is identical before and after.
- **Includers do not change.** `DatabaseConfig.cpp:7` and `ControllerService.cpp:31` keep
  `#include "db.hpp"`: not found beside the includer (`lib/src/elodin/`, `lib/src/control/`), not on
  `lib/include`, `lib/src`, `transport/include`, then found on the SYSTEM directory, as today.
  (`DatabaseConfig.cpp:7`'s trailing `// utl/db.hpp — …` goes stale; §5 step 5.)

`lib/CMakeLists.txt` after the change (replacing the block at 54-60 / 55-61). The carried-forward
comment said "db.hpp alone accounts for every -Wmissing-field-initializers left in the tree"; that
is **false** — `baseline_warnings.txt` carries two live ones, `lib/test/test_hold_rules.cpp`
(`gate_actuator`) and `services/sequencer/ScriptRunner.cpp` (`vars`) — so the rewritten block says
what is true:

```cmake
# SYSTEM so the vendored Elodin encoder (third_party/elodin/db.hpp) does not report warnings we are
# not going to act on (its -Wmissing-field-initializers). Suppressing the warning itself would hide
# the live ones in our own code (two in baseline_warnings.txt today; 22 in SensorAssignment.cpp once
# turned out to be two struct fields nothing reads), so it is scoped to the vendored header.
# PRIVATE: only fsw_daq_lib's own sources include it (DatabaseConfig.cpp, ControllerService.cpp).
target_include_directories(fsw_daq_lib SYSTEM PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/elodin
)
```

`services/CMakeLists.txt:7`: delete the `archive/legacy/utl` line from `COMMON_INCLUDES`.

`test/characterization/config/CMakeLists.txt:10`: delete the `${_DS}/../archive/legacy/utl` line
from `_CFG_INCLUDES` (**D45(5), D62**: WP3's, in this commit). It is redundant today — its
targets link `fsw_daq_lib` (whose `SYSTEM PUBLIC` path propagates now) and none of the three mains
`char_config_services.cpp` includes, nor `char_config_dump`'s sources, includes db.hpp — and after
the move it would name a directory that no longer exists (not an error: `-Wmissing-include-dirs`
is not in `-Wall -Wextra -Wpedantic`, but a dangling path is noise). This is a D18 harness edit:
goldens byte-identical, the `config` area's mutation checks re-run in the package, the one-line
harness diff reviewed by the orchestrator (§6).

Why PRIVATE is not a behaviour change: the property only decides which compile lines carry
`-isystem …/utl`. Every target other than `fsw_daq_lib` loses that flag; none of their sources
includes `db.hpp` or any header that does, and after WP2 the directory holds no other file a
`#include` could resolve to. Codegen of those TUs is unchanged; the build proves it (no new warning,
no missing include).

References outside WP3's files, by owner (all must be updated or confirmed, none silently left):

| reference | owner | action |
|---|---|---|
| `lib/CMakeLists.txt` 54-60 / 55-61; `services/CMakeLists.txt:7`; `test/characterization/config/CMakeLists.txt:10` | WP3 | as above |
| `githooks/pre-push:22,26` (`git diff --quiet HEAD -- … daq-server/archive/legacy/utl …`, and the message that names the path) | WP3 (under `daq-server/`) | drop the path: `daq-server/diablo_server` already covers `lib/third_party/` |
| `test/characterization/gate.sh:118` / `:119` (`git ls-files … 'daq-server/archive/legacy/utl' …` for `format_check`; one line) | C0 | an empty pathspec match is not an error; db.hpp is still format-checked because `daq-server/diablo_server` now contains it and `format_check` prunes only `nlohmann`/`toml++`. Orchestrator drops the path |
| root `format.sh:28` `TARGETS` | orchestrator | drop the line (covered by `daq-server/diablo_server`). `find_cpp_files` (141-155) prunes `external`, `build`, `.pio`, `Archive`, `libraries`, the CubeMX files, `node_modules`, `nlohmann`, `toml++` — **not** `third_party`, so db.hpp stays in `./format.sh`'s set |
| `.github/workflows/daq-server-ci.yml:227` ccache key | orchestrator | drop the two `archive/legacy/utl` globs; the key goes cold once (harmless) |
| `.github/workflows/daq-server-ci.yml:303,383,397` (TODO / secrets / unsafe-function greps, each `… \|\| true`) | orchestrator | drop `archive/legacy/utl/` (a missing path makes `grep -r` print an error to stderr); db.hpp is still scanned under `diablo_server/` |
| `.github/workflows/daq-server-ci.yml:325` (`if grep -r "#include <iostream>" … diablo_server/ archive/legacy/utl/ \| grep -v "#include <iostream>" \| head -5; then`) | orchestrator | drop the path; **the `if` outcome is unchanged**, verified (D62): the workflow sets no `shell:` (only `defaults.run.working-directory`), so the step runs under GitHub's default `bash -e {0}` — **no `pipefail`** — and the condition's status is the last command's, `head -5`, which exits 0 on empty input (`-e` is inert inside an `if` condition). The second `grep -v` removes every line the first `grep` matched, so the stream is empty and the `if` is true today and stays true; the only difference is `grep`'s stderr line about the missing directory not appearing. That the step is vacuous is a `main` CI defect candidate (§8 Q4) |

db.hpp is **clang-format-19 clean at the new path** (checked with the pinned 19.1.7 on a copy at
`diablo_server/lib/third_party/elodin/db.hpp`; `daq-server/.clang-format` governs both the old and
the new path) and stays checked by `./format.sh` and `gate.sh format_check` through
`daq-server/diablo_server`, as above.

### 2.3 One `send_msg`

The two live copies (PSM's lambda at `PressureStateMachine.cpp:733-738` dies with PSM):

| | `DatabaseConfig.cpp:16-24` (banner comment at 15) | `ControllerService.cpp:921-927` |
|---|---|---|
| namespace | `fsw::elodin`, file `static` | `fsw::control`, file `static` |
| encode | `Msg(msg).encode_vec()` | same |
| empty buffer | `std::cerr << "[DatabaseConfig] Failed to encode message" << std::endl;` then `return false` | `return false`, silent |
| send | `client.send_msg({0, 0}, buf)` | same |

Encode failure is practically unreachable (`encode_vec` sizes the buffer with `encoded_size()`
first) and no black-box test can provoke it, but D17 is statement for statement: the shared function
takes the failure text, `nullptr` meaning silent. Two users, two values: not a single-user knob
(STYLE-S34 is met: two real users today).

```cpp
// lib/src/elodin/SendMsg.hpp (stub: docs/remaster/design-stubs/cpp/lib/src/elodin/SendMsg.hpp)
namespace fsw::elodin {
template <typename T>
inline bool send_msg(ElodinClient& client, T msg, const char* encode_failure_line);
}
```

`DatabaseConfig.cpp` (56 calls): delete 15-24, `#include "elodin/SendMsg.hpp"`, and give every call
the text. To keep the 56 call sites a one-token change, a file-static forwarding overload is **not**
added (it would be a second `send_msg` again); instead each call becomes
`send_msg(client, X, kEncodeFailed)` with `static constexpr const char kEncodeFailed[] =
"[DatabaseConfig] Failed to encode message";` at the top of the file. `ControllerService.cpp`:
delete 921-927, include the header, the 15 calls (993-1001, 1033-1047) become
`fsw::elodin::send_msg(*elodin_client_, X, nullptr)` (qualified: `ControllerService.cpp` is in
`fsw::control`; ADL on `ElodinClient` would find it too, but the qualification says where it
lives).

`#include "db.hpp"` stays in both `.cpp` files as well (they use the builder DSL directly);
`SendMsg.hpp` includes it itself so it is self-contained.

**What makes `SendMsg.hpp` lib-private, precisely.** Not its directory: `lib/src` is on
`fsw_daq_lib`'s **PUBLIC** include list (`lib/CMakeLists.txt` 48-52 / 49-53), so any consumer can
resolve `#include "elodin/SendMsg.hpp"`. The mechanism is the header's own `#include "db.hpp"`,
which resolves only on the `SYSTEM PRIVATE` directory of §2.2; a service or harness TU that
includes `SendMsg.hpp` fails with "db.hpp not found" (§4). The privacy is enforced by the
compiler, not by a convention or a directory property, and the stub's doc comment says so.

**For WP10** (DESIGN-WP10 §3.3 "if WP3 has already replaced `send_msg`… the include moves"): the
include to move into `ControllerService_elodin.cpp` is `#include "elodin/SendMsg.hpp"`; the calls
are `fsw::elodin::send_msg(*elodin_client_, …, nullptr)`; `#include "db.hpp"` and the two
`using namespace vtable…` lines (35-36) move with `registerControllerTables`.

### 2.4 Printer

Cut `Parser.cpp` 824-931 (the blank line, the `// ───` / `// Canonical printer` / `// ───` banner
at 825-827, the anonymous namespace 828-925 with `printExpr`, the `printBlock` forward
declaration, `printStmt`, `printBlock`, and `print_canonical` 927-931) into
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
`src/script/Printer.cpp` after `src/script/Parser.cpp` (`lib/CMakeLists.txt:18`) in `FSW_SOURCES`.

**Size.** `Parser.cpp` is 934 lines; the cut leaves it at **~826**, still over STYLE-S33's 700 for
a C++ TU, and the move deletes nothing. It stays whole on purpose: the directory's convention is
**one stage per TU** (`Lexer.cpp`, `Parser.cpp`, `Validate.cpp`, `Slug.cpp`, now `Printer.cpp`),
and the remaining 826 lines are the one parser (its anonymous-namespace helpers 126-811 and the
`parse` entry). S33 is "targets, not gates", so no waiver entry is needed; a further split would be
a reshuffle, not hygiene.

The move is proven self-contained by the build: any reference from the printer block into
`Parser.cpp`'s first anonymous namespace (126-811) would be an undefined name or a link error in
`Printer.cpp`, never a silent change.

D22: `printExpr`'s `std::to_string(e.number)` is formatting, not arithmetic; no expression is
contractible. The printer has no callers inside `Parser.cpp` (anonymous-namespace helpers used only
by `print_canonical`), so `Parser.cpp` keeps no unused static (`-Wunused-function` would otherwise
trip D4).

### 2.5 Dropped: `table_id_for` (D62)

The deepened note's step 5 — one pure `fsw::elodin::table_id_for` in `lib/include/elodin/TableId.hpp`
replacing the lib's copies of `(slot-1)*0x20 [+0x10] + ch`, plus a ctest on its uint8 wrap — is
**dropped** on D49's test ("does each piece earn its cost at all?"):

- It deletes nothing. Each replaced expression is one line; the header, the ctest and its CMake
  registration are net new code.
- It does not deliver the "one place" the research asked for (subscription-robustness Idea 1). The
  same expression stays in `daq_bridge/daq_bridge_main.cpp:898` (the publish base),
  `services/sequencer/ActuatorCommander.cpp:40` (`actuator_elodin_low_byte`),
  `lib/src/t7/T7Calibration.cpp:34` (`cjc_table_id`, `+ kCjcTableOffset`),
  `services/calibration/calibration_main.cpp:1966-1968` (`cal_lo = type_lo + 0x10` and the slot
  inverse) and the TS `elodin-vtable-registry`; WP9 and WP10 both decline adoption
  (DESIGN-WP9 §2, DESIGN-WP10 §6.2). The deepened note's inventory also **missed**
  `DatabaseConfig.cpp:680,692` (the ACT_CMD registrations, 0x32) and **misdescribed**
  `ControllerService.cpp:772-775` as "`base` without the channel": 773 computes the base and 775
  adds `0x10 + ch`, so it is the full expression, split across two lines. A D-SLOT package starts
  from this corrected list, not from the old one.
- The fail-closed site for D-SLOT already exists and is not a table-id computation:
  `lib/src/config/Config.cpp:49-55` (`if (slot > 8) { std::cerr << "[Config] ERROR: … maps to
  slot …" }`; the ledger's `49-53` names the same block). A fix that refuses the configuration
  there needs no helper in the registrars.

`table_id_for` **may land later inside the D-SLOT fix package**, where it would have a reason (one
clause, with the compiler listing every caller that must decide what a refused id means). With
D49(10) (no `register_all_tables`) this retires D42 binding 3. The stub
`design-stubs/cpp/lib/include/elodin/TableId.hpp` is deleted with this republication.

The slot rule itself (`board_id % 10`, 0 → 10) has its own copies (`CubicCalibrationStore.cpp:26`,
`LcTareStore.cpp:30`, `actuator_elodin_low_byte`, `calibration_main.cpp:497/524`,
`BoardConfig::slot()`); recorded for the team beside D-SLOT, not WP3's.

### 2.6 Interfaces (stubs)

One new header, as a declaration-only stub with ownership/threading/error/must-not-know comments
(STYLE-S36), under `docs/remaster/design-stubs/cpp/` (not built, in no CMake target):

| stub | becomes | users |
|---|---|---|
| `lib/src/elodin/SendMsg.hpp` | `diablo_server/lib/src/elodin/SendMsg.hpp` | `DatabaseConfig.cpp`, `ControllerService.cpp` (→ `ControllerService_elodin.cpp` in WP10) |

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
| a target that newly needs db.hpp (directly or through `SendMsg.hpp`) | — | compile error "db.hpp not found" (by design: link through `fsw_daq_lib`'s sources, or make the path PUBLIC in its own commit) |

## 5. Passes (one package; WP3 is hygiene, not a god-file split, so no separate cleanup item)

One commit each, in this order, each built and guarded:

1. Delete PSM (`.cpp`, `.hpp`, `lib/CMakeLists.txt:29`).
2. `git mv` db.hpp; `lib/CMakeLists.txt` SYSTEM PRIVATE block; `services/CMakeLists.txt:7`;
   `test/characterization/config/CMakeLists.txt:10` (D18, §2.2); `githooks/pre-push:22,26`. Hand
   the orchestrator its lines (§2.2 table: `gate.sh`, `format.sh:28`, yml 227/303/325/383/397).
3. `SendMsg.hpp`; adopt in `DatabaseConfig.cpp` and `ControllerService.cpp`.
4. `Printer.cpp`; `FSW_SOURCES`.
5. Optional, separate (STYLE-S38: stale comments are corrected outside a move): the two comments
   the moves leave false — `ControllerMessages.hpp:71` ("Written by PressureStateMachine …") and
   `DatabaseConfig.cpp:7`'s `// utl/db.hpp — …`.

Format only touched files with the pinned clang-format 19.1.7 (db.hpp is not touched; it is
already clean, at both paths).

## 6. Guarding characterization

| change | guarded by | check |
|---|---|---|
| PSM deletion | build; `packets/comms_messages.cpp` (compiles `ControlMessages.hpp` and `ControllerMessages.hpp`) | `ctest -R char_packets_comms_messages` (no lock needed) |
| db.hpp move | `git diff -M100%` (rename only); clean build with **no new warning** vs `baseline_warnings.txt` (proves the SYSTEM path survived); `elodin/golden/schema_{config_base,profile_default}.txt` (every registration byte from daq_bridge, calibration, sequencer, controller, t7_bridge, heartbeat, stacklight) | `CHAR_AREAS=elodin,packets,config` under the lock |
| `_CFG_INCLUDES` line (D18) | `config/golden/**` byte-identical; the `config` area's mutation checks re-run; the one-line harness diff reviewed by the orchestrator | same run (`config` is in the set) |
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

## 8. Open questions and report-only items

1. `ControlMessages.hpp` now exists only because `packets/comms_messages.cpp` freezes it. Keep it
   (this note), or have C0 drop it from the test with the golden lines accounted for (D20)? Team /
   orchestrator.
2. Defect candidate (report only): the two `send_msg` copies disagreed on whether an encode failure
   is logged; kept as-is via the parameter.
3. Report only: `daq-server/build-clang-ci/` is a checked-in build directory (§2.1). Its removal is
   not WP3's.
4. Defect candidate in `main`'s CI (report only): the yml:325 "missing includes" step always takes
   its `if` branch (§2.2), so it warns on every run and detects nothing.

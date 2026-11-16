# backend-remastered — STYLE

The rules every remastered file conforms to. Cite them as `STYLE-S<n>` (the design notes already use
bare `S1`–`S4` and `R1`–`R10` for their own rules; see the conflicts section). Paths are relative to
`daq-server/diablo_server/` unless they start with `test/`, `docs/` or `config/`. Line numbers are
`backend-remastered` @ `85a02f9a` (product code = `main` @ `15b5a0c5`).

**Precedence.** Behaviour beats style. AGENT-RULES 4–6 and D17 come first: a rule here that would
change an observable (bytes, replies, exit codes, timing, log lines a harness reads, startup order)
yields, and the existing behaviour is kept and made explicit (S12). A **move-only** pass applies
only the rules its note allows (WP6 §6.1, WP7 §6.1, WP9 §6.1, WP10 §6.1: no renames, no added
lines beyond includes/namespaces/signatures); the rest of this file is for the **cleanup** pass and
for new code. Each rule names the WPs it bites hardest; the defect ids are in `LEDGER.md` Defects.

---

## 1. Naming

**S1 — A new C++ symbol takes the casing of the directory it lands in.** The tree is not uniform,
and the split is by area, not by age (function declarations counted per directory):

| camelCase | snake_case |
|---|---|
| `lib/include/control` (115:4), `lib/include/net` (2:0), `services/sequencer` (21:5), member functions of `SequencerService`, `ActuatorCommander`, `ControllerService` | `lib/include/config` (0:46), `lib/include/elodin` (0:36), `lib/include/calibration` (20:75), `lib/include/time` (0:7), `lib/include/fsw` (0:9), `daq_bridge` (0:13), `services/calibration` (1:35); `ElodinClient` members (`subscribe_tables`, `read_packet`) |

Good: `fsw::net::bindToDaqInterface` (`lib/include/net/DaqInterface.hpp`) beside
`fsw::config::load_active_boards`. A brand-new namespace (`fsw::service`, WP8) picks one and keeps
it. A name a doc or the LEDGER uses is not an observable and does not override this rule. WPs: 8, 9,
10.

**S2 — C++ files.** One class per `PascalCase.{hpp,cpp}` pair (`ActuatorCommander.{hpp,cpp}`);
executables `<service>_main.cpp` (`heartbeat_service_main.cpp`, `calibration_main.cpp`); a class
split across TUs is `<Class>_<aspect>.cpp` with the header untouched (WP10 §5:
`SequencerService_elodin.cpp`); a service's private TUs live in the service directory and link
into that executable only (WP9 §2, `services/calibration/`), not into `fsw_daq_lib`. WPs: 9, 10.

**S3 — C++ identifiers.** Types `PascalCase`; data members trailing `_` (`config_mutex_`);
file-scope mutable globals `g_` (`g_running`, `services/sequencer/sequencer_main.cpp:46`); new
constants `kPascalCase` — the majority (158 `k…` vs 72 `SCREAMING_…` constexpr/const), e.g.
`kMaxClients` (`sequencer_main.cpp:51`), `kElodinRecvTimeoutMs`
(`services/heartbeat/heartbeat_service_main.cpp:41`). Existing `SCREAMING` constants stay
(`lib/include/control/RobustDDPController.hpp:18-23`, `daq_bridge/daq_bridge_main.cpp:31`,
`VTABLE_SEQUENCER_STATE`); so do per-service constants a README cites by name (WP8 §5). WPs: 8–10.

**S4 — C++ namespaces.** New code goes in `fsw::<area>` (`fsw::net`, `fsw::config`, `fsw::elodin`,
WP8's `fsw::service`, WP9's `fsw::calibration_service`). Inside `namespace fsw`, spell config types
`::fsw::config::Config` (the `fsw::fsw` trap, `lib/include/net/DaqInterface.hpp:54-57`). Recorded
exceptions: `sequencer::` stays; daq_bridge's moved types stay global (WP10 §4.3 — a namespace would
need a second harness edit). WPs: 8–10.

**S5 — TS files and directories.** kebab-case `.ts` (all tracked `backend/src` files already are).
A directory means one thing: `routes/` = domain libraries the harnesses import by path, `api/` =
HTTP route handlers (WP7 D-a), `server/` = the WS-side modules of the backend process (WP6 §2). A
module is named for what it owns (`board-status`, `engine-state`), not a pattern; the existing
`session-manager.ts`, `calibration-handler.ts` keep their names, no new `*-manager`/`*-service`/
`*-handler` is minted (WP6 §5). WPs: 5–7.

**S6 — TS identifiers.** Functions and state `camelCase`; types `PascalCase`, no prefixes;
`SCREAMING_SNAKE` only for values that never change (`BOARD_HEARTBEAT_STALE_MS`). A mutable `let`
is camelCase: `STATE_ACTUATOR_MAP` (`backend/src/server.ts:430`) and `_hpBoardNumbers` (`:329`) are
renamed in WP6 step 2 only. Verbs, from WP6 §5 and WP7 §5: `handle<Input>` at an input boundary
(`handleMessage`, `handleElodinPacket`, `handle<Group>Request`), `on<Source><Event>` for listeners,
`init*` / `reload*` / `reset*` for owned-state reads, `broadcast*` (all clients) vs `send` (one),
`note*` records an observation, `set*` is the owner's single writer. WPs: 6, 7.

**S7 — Never rename what something outside the file reads.** Log tags and texts (S15), WS message
`type`s, payload keys and key order, URLs (including the mixed `/api/ball_valve_cal` vs
`/api/feed-char`), env vars, notification keys, `__daq*` socket properties, `ActuatorCommander`'s
private members (`test/characterization/config/char_ac_private.cpp`, WP10 §7.2), stacklight's
external-linkage `getTomlValue` (WP8 §6.2), file-statics a `#include`d main exposes to
`char_config_services.cpp`. Move-only passes rename nothing (WP9 §5, WP10 §5). WPs: all.

## 2. Error handling

**S8 — The refactor preserves every failure mode.** Defects are parked, not fixed (D17,
AGENT-RULES 6): status codes, exit codes, error texts, "continue" vs "exit", what is left half
written. Everything below S8 describes the shape new structure takes and the direction a future,
team-approved fix takes (golden first, then the fix, as its own package). A refactor never applies
it to existing behaviour. WPs: all.

**S9 — Catch only where input enters.** TS boundaries are WP6 §4.3's table (browser message,
browser command, Elodin row, sequencer line, HTTP request, process) plus WP7's router catch. C++
boundaries are a TCP client reader, an Elodin read loop, `main`'s startup, and a command worker —
good: `services/sequencer/SequencerService.cpp:94-105` catches a throwing command, logs it and still
fulfils the promise. Inner modules do not catch-and-log unless the catch *is* a decision (config
missing → defaults, WP6 §4.3). A try/catch moves with its body and keeps its exact span; a move adds
none and removes none (WP6 §4.2, WP7 §4.2, WP9 §4). WPs: 6, 7, 9, 10.

**S10 — Every request gets exactly one answer; every accepted subscription delivers or fails
loudly.** What `main` gets wrong, kept by the refactor: `backend/src/api-server.ts:397-398` (and
~40 more) write headers before evaluating the body, so a throw leaves `server.ts:888-893` nothing
to send and the request hangs (D-API3); a throw inside a `req.on('end')` callback outside its try
never answers; a subscription made during re-registration is accepted and dead forever, and
`backend/src/elodin-vtable-registry.ts:136` retries only refused ones (D-SUB). The canonical trap
when tidying: a helper that evaluates the body before `writeHead` silently fixes D-API3, so WP7's
`sendJson` is allowed only on literal/local bodies (WP7 §6.2, D39). WPs: 5–7.

**S11 — Fail fast on configuration that makes a service unsafe or useless; never start "on
defaults" silently.** One stderr line with the tag, exit 1, before any socket opens. What `main`
does instead, kept: `lib/src/config/Config.cpp:49-53` logs `[Config] ERROR` for slot > 8 and
continues, so the table id wraps onto PT2.CH1 (D-SLOT); `services/controller/controller_main.cpp:147`
ignores `listen()`, and a bind failure returns from the control thread while the service runs on
with no fire gate (D-CTL); `config::load` logs and returns defaults (C2-4); a malformed IP becomes
`0.0.0.0` on the wire (C1-8); `heartbeat_service_main.cpp:252` ignores `bindToDaqInterface` (D-BIND);
the same bad board id is SIGABRT in config_broadcast and exit 1 in daq_bridge (C2-12). WPs: 8–10.

**S12 — Preserved behaviour is explicit, never a silent default of shared code.** Where one helper
serves services that behave differently, each service's behaviour is a named setting at its call
site. Models: WP8 §2.1 `ShutdownNotice` and `Sigpipe` per-service tables; §2.3 `TcpListener::Failed`
returned to the caller, who decides (the controller falls through on `kListen`, the others exit 1);
§2.5 `ConfigFileChoice{found, fell_back}` with the caller emitting its own log lines. In the cleanup
pass a kept defect at a call site carries `// Kept: <LEDGER id> (D17)` and one line on why; a
move-only pass adds no such line (its diff rules forbid it). WPs: 8–10.

**S13 — Exit codes.** 0 on clean stop and `--help`; 1 for a startup failure, with one stderr line.
Frozen exceptions (WP8 §4): t7_bridge 2 and 3, config_broadcast −6 (C2-12), −2/−15 before a
service's handlers are installed, −13 for SIGPIPE in the five default-disposition services,
calibration's `return 1` on first Elodin connect (`services/calibration/calibration_main.cpp:1545`,
C6-9). New helpers return status; only `main` exits. `std::exit` inside a helper exists only where
moved verbatim (t7_bridge's `next` lambda, WP8 §6.2). WPs: 8–10.

**S14 — Keep a seam's error style.** Where a seam returns status, it keeps returning status: the
TS line client never rejects and resolves `{ok, reply}` (WP6 §4.1); `SequencerService` returns
`bool` plus `refusal_reason`, which the TCP layer prints after `ERR:` (WP10 §1.6). No new exception
crosses such a seam. WPs: 5, 6, 10.

## 3. Logging

**S15 — A log line a harness reads is contract.** Never change its bytes — emoji, the leading
`\n`, U+2026 `…` in the controller's signal line (WP8 §6.1 step 8), two-space gaps. Read today by:
`test/characterization/lifecycle/lifecycle.py:830` (`Listening for DiabloAvionics packets`), `:890`
(`Elodin|subscrib`), `:1083` (`subscriptions sent`), `:1478` (`[DAQ Bridge] Shutdown complete`);
`test/characterization/pipeline/run.sh:215` (`VTableStream: sent` / `queued for the next pass`);
`test/characterization/sequencer/char_sequencer.py:356,365` (`SEQ_FACTS`, `CTL_FACTS`);
`test/test_integration.sh:992-993`; everything a `#include`d main prints in
`config/golden/cpp/`, and daq_bridge's startup through `[System] Mode` in `config/golden/bin/`.
Move-only check: the sorted multiset of string literals is identical before and after (WP9 §6.1).
WPs: all.

**S16 — Tags.** Every line carries its component's existing tag, and tags are not unified:
`[Sequencer]` (main) vs `[SequencerService]` (class), `[controller_service]` vs
`[ControllerService]`, `[ThinServer]`, `[WS_BACKEND]` (WP6 §5, WP8 §5). New code in an existing
component uses that component's tag; a new component uses `[PascalName]`. WPs: 6, 8, 10.

**S17 — Streams, not levels.** There is no logger. C++: progress to `std::cout`, failures and
warnings to `std::cerr`, ended with `std::endl` (the flush is what orders captured output). TS:
`console.log` / `warn` / `error`. Hot-path logs are rate-limited by counters as today
(`calibration_main.cpp` `debug_limit`, the controller's `tick % 10/50/100`), not by clocks. Lines
from several threads are assembled and written under one leaf lock (good:
`services/t7_bridge/t7_bridge_main.cpp:60-67`). No logging framework (one user). New signal
handlers print nothing (S25). WPs: 8–10.

## 4. Config access

**S18 — C++: `main` reads config once and passes values down.** `main` calls `fsw::config::load`
once, resolves the service's own precedence in one block, and hands `const ::fsw::config::Config&`
or plain values to what it constructs; library code never opens `config.toml`. Good: heartbeat
`heartbeat_service_main.cpp:217-226`. Frozen, not patterns: daq_bridge loads at
`daq_bridge_main.cpp:169` and `:377` (plus `load_active_boards`); config_broadcast loads at
`config_broadcast_service_main.cpp:186` every cycle, `:494` and `:521`; stacklight parses TOML
itself (C2-3). Precedence differs per service (WP8 §1.4: config over CLI in stacklight, C1-11) and
is never unified. WPs: 8–10.

**S19 — TS: config is read from a named function the composition root calls.** Through
`routes/config.ts` (`readConfig`, `readDeployedConfig`), from an `init*`/`reload*` function that
`server.ts` calls in its documented order, or per request inside a handler where it is today. Never
at import in a new module (S30). Frozen: `legacy/state-actuators.ts:79-81` builds three maps from
config at import; `session-manager.ts:401` constructs its singleton at import. WPs: 5–7.

**S20 — One owner per derived cache, reloaded at named points.** A cache built from config has one
owning module with `init*`/`reset*` (WP6 `server/config-caches.ts`), rebuilt only at the named
reload point — today `applyDeployedConfigChange` (`backend/src/server.ts:848`, clearing the slot
caches at `:854-857`) and `onStateCsvUpdated`. The process environment is read once, in one
module (WP6 `server/env.ts`). WPs: 6.

## 5. C++ lifetime and ownership

**S21 — Name the owner of every resource; RAII when its lifetime is a scope.** Good:
`lib/src/elodin/ElodinClient.cpp:14`, `lib/src/control/ControllerService.cpp:74-78`. Where *when* an
fd closes is observable, keep the explicit `close()` where it is; shared helpers then return a raw
fd and the caller owns it (WP8 §0 rejected an owning `UdpSender`: heartbeat closes its socket before
joining the Elodin thread). A helper's doc comment says who closes on which path (WP8 §2.3
`openTcpListener`: callee closes on socket/bind failure, caller owns the fd otherwise). WPs: 8, 10.

**S22 — Every thread has a stop path and an owner that joins it.** Stop = an atomic flag checked at
a bounded interval (sleeps in ≤ 100 ms slices, as `services/sequencer/ActuatorCommander.cpp:655-656`;
receive timeouts as `kElodinRecvTimeoutMs`). Good: `SequencerService.cpp:55-71` (drain order, with
the reason), `sequencer_main.cpp:343-353` (`shutdown` every client, join, then close). New threads
are joined, never detached. The existing detaches are frozen and listed here so nobody "fixes"
one in a refactor: `controller_main.cpp:501`, `ota_service_main.cpp:453`,
`ActuatorCommander.cpp:610`, `HoldTimer.cpp:74`, `ScriptRunner.cpp:114`,
`AbortBroadcaster.cpp:150` (WP8 §3, WP10 §6.2). WPs: 8, 10.

**S23 — Mutex discipline.** (a) The header states, next to the members, which mutex guards which
fields and the lock order — good: `lib/include/control/ActuatorCommander.hpp:202-206`. (b) Never
call, from inside a locked scope, a function that takes the same lock: C4-1 is
`SequencerService.cpp:717` → `publishState()` at `:727` → `:1130`, a self-deadlock on a
non-recursive mutex that leaves aborts failing. (c) Network and Elodin I/O happen after the lock is
released (`publishState` drops `config_mutex_` before publishing). (d) `recursive_mutex` is never
the fix. In a refactor: no new mutex, no new nesting, C4-1 moved verbatim (WP10 §1.3, §2.2). WPs: 10.

**S24 — Shared state is atomic or guarded, with one stated exception.** Plain globals are allowed
only when written before the first thread is created and never again, and the comment says so (WP8
§2.1's `g_line`/`g_notice`). Existing races (`ControllerService::fire_start_time_`,
`ActuatorCommander::elodin_`) are reported, not fixed (WP10 §3.2, §2.2). WPs: 8, 10.

**S25 — Signals.** After WP8, every service installs through `fsw::service::installStopHandlers`
with its row of WP8 §2.1's table, exactly where it installs today (§1.2 — before `svc.init()` in
the sequencer, after `initialize()` in the controller), before its first thread; `::signal`, never
`sigaction`; today's handler bodies statement for statement (the non-async-signal-safe printing is
parked defect 6); SIGPIPE per service (LEDGER Parked). A new handler only stores to an atomic —
good: `t7_bridge_main.cpp:83-85`. WPs: 8, 9 (cleanup C1), 10 (daq_bridge cleanup).

**S26 — No work at static-initialisation time.** No namespace-scope object with dynamic
initialisation (`std::string`, `std::map`) in a new TU, only constant-initialised atomics and
`constexpr`; no TU prints or opens anything at load (the config harness captures stdout around a
`#include`d main, WP8 §2.1; WP10 §8). WPs: 8–10.

**S27 — Move file-statics, never copy them.** A `static` left behind in a TU that no longer uses it
is a new `-Wunused` warning against `test/characterization/baseline_warnings.txt` (D4; WP10 §1.4).
Linkage changes only where a split needs it, and the note lists it (WP10 §4.3 `BoardMap.cpp`).
WPs: 9, 10.

## 6. TS async and modules

**S28 — Every promise is awaited inside a boundary's try or carries its own `.catch`.** Inside the
router: `if (await handleX(req, res, url, opts)) return true;` — never `return handleX(...)`
unawaited, which lets a rejection escape the catch and turns a 500 into a hang (WP7 §4.2). Frozen:
`server.ts:1508` and `:1590` call `registerVTables(...).then(...)` with no `.catch`; adding one
changes which guard logs (WP6 §4.2) — it is a parked inconsistency. The process keeps its crash
guards (`server.ts:1823-1829`) and has no SIGTERM handler (C6-5, frozen in
`lifecycle/golden/shutdown.txt`). WPs: 5–7.

**S29 — Fire-and-forget is deliberate and named.** Only where nothing waits on the result and the
order is not observable, with a comment saying so: the history backfill on connect (WP6 §6.5).
`setImmediate` deferral of `onConfigUpdated`/`onStateCsvUpdated` (response first, callback after)
and the synchronous `onCalibrationReload` keep their timing (WP7 §3.3). WPs: 6, 7.

**S30 — No effects at import in a new module.** Top level holds only imports, types, constants
from literals, `process.env` or `import.meta.url`, pure constructors (`new Map`, `new
ElodinClient(...)`) and function declarations; every disk read, log, timer, listener and socket is
in a function the composition root calls (WP6 M1, WP7 §2). Existing modules keep their import-time
effects, and their evaluation order is kept by importing new modules *after* every existing import,
with the import-closure check (WP6 R1, WP7 S2). WPs: 6, 7.

**S31 — The import graph is a layered DAG.** Each module imports only from lower layers (WP6 M2,
table in §2); `server/*` and `api/*` never import each other or `api-server.ts`. Injection is used
only where it breaks a real cycle: `createAPIHandler(opts)` (`server.ts:784`),
`sessionManager.init(callbacks)` (`server.ts:1869`), `CalibrationHost` (two users). Check with the cycle grep of WP6 §6.3. WPs: 6, 7.

**S32 — Module state has one owner, read through live bindings.** Only the owner assigns; others
read `export let` bindings or call the owner's setter (WP6 §3.1, §6.2). Never `export const x = y`
of an imported `let` — re-export with `export { y } from` (WP6 R5); never copy a live binding into a
local that outlives the call (WP6 R6, §8). `npx tsc --noEmit` exit 0 on every commit is what makes
a missed setter a build error (D40). Forward-looking: today every cross-module write is inside
`server.ts`; WP6 §6.2 lists the eight that become setters. WPs: 6, 7.

## 7. Size and abstraction

**S33 — Size targets, not gates.** TS composition root < 400 lines and modules ~200–300 (WP6 §2);
C++ TU ≤ 700 (WP10 DoD, the BLOAT-MAP god-file line); a `main` < 400 where reachable. Waivers are
recorded in the LEDGER (D39: WP9's main ~430). A cohesive file over the line stays whole
(`RobustDDPController.cpp`, BLOAT-MAP §4). WPs: 6, 7, 9, 10.

**S34 — An abstraction needs two real users today, and two is not enough.** "Abstraction" as WP10's
preamble defines it: a new class, interface, template, callback type, or configuration knob. Not an
abstraction: moving member functions to another TU of the same class; extracting a block of a god
function into a named free function with one call site, in cleanup, where the note lists it; a
method-less struct that carries existing locals across TUs (WP9 §2 `CalibrationContext`,
`StreamState`). Users that differ in anything observable stay separate code (WP8 §0 rejected
`ServiceMain`, a shared argv parser, `SubscriberLoop`, `UdpSender`, a shared `trim()`). A parameter
that every caller passes the same value is a constant (WP8 §2.3's 10 ms select). D17(d). WPs: 5–10.

**S35 — Delete the dead user instead of generalising over it.** One live caller plus one dead one
is one user: WP5 deletes the uncalled :9999 `sendToControllerService` (`server.ts:1443`) rather than folding both into
`sendLine(port, line, isOk)` (D39, WP6 Q1). WPs: 5.

## 8. Comments and docs

**S36 — Every new header and module opens with a doc comment that says:** what it owns (state, fds,
threads); which threads call in and under which lock; what it must not know or import (e.g. WP6 §2:
`server/*` never imports `api-server.ts`; WP7 §2 the inverse); the contract surfaces it touches,
naming the golden that freezes them. It explains why, not what. Good:
`lib/include/net/DaqInterface.hpp:11-26`, `backend/src/client-outbox.ts:1-25`,
`lib/include/control/ActuatorCommander.hpp:202-206`. WPs: 6–10.

**S37 — Odd-but-kept behaviour is labelled at the site.** A kept defect names its LEDGER id (S12); a
timing constant says what bound it feeds (good: `heartbeat_service_main.cpp:40-41`; the lifecycle
README cites it by name). WPs: 8–10.

**S38 — Comments move with their code.** Cut whole definitions with their leading comment blocks
and section banners (WP10 §6.1); a misplaced comment moves where it is (WP9 §1.1:
`calibration_main.cpp:464-466`). Stale comments are corrected in cleanup, not in move-only. TS
`// ── … ──` section banners are anchors the notes use; keep them. WPs: 6, 7, 9, 10.

## 9. Formatting (reference, not restated)

**S39 — C++ and Python.** C++: `daq-server/.clang-format` (Google base, 4-space indent, ColumnLimit
100, `SortIncludes` + `IncludeBlocks: Regroup`); the root `.clang-format` (80 columns) does not apply
inside `daq-server/`. clang-format 19.1.7 from the pinned venv (D6), on touched files only
(AGENT-RULES 10); the gate runs it `--dry-run --Werror` (D11). Python: black 25.11.0 (D10) on new
`.py` files only; daq-server Python is not black-clean on `main` and is left so. WPs: all.

**S40 — TS has no formatter or linter.** No eslint or prettier config is tracked in
`backend/` or `frontend/`; the frontend's `lint` script is `tsc --noEmit`, the backend has none.
Match the file: 41 of 49 `backend/src` files use 2-space indentation, 7 use 4; single quotes
dominate (`history-backfill.ts`, `script-status.ts` use double). A new file uses 2 spaces, single
quotes, semicolons. Moved code is not reformatted. Adding a formatter is out of scope (it would
rewrite every file). `tsc --noEmit` (D40) is the only static gate. WPs: 5–7.

---

## Conflicts with current design notes (for the orchestrator)

1. **Rule-label collision.** WP7 §6.1 numbers its rules `S1`–`S4`; WP6 uses `R1`–`R5` in §6.1 and
   `R1`–`R10` in §8. Proposal: cite as `STYLE-S12`, `WP7-S1`, `WP6-R5` (§6.1) / `WP6-risk-R5` (§8).
2. **C++ function casing (S1).** WP8 puts camelCase `followSequencerState` into `fsw::elodin`
   (`lib/include/elodin`: 0 camel, 36 snake) and `findConfigFile`/`readFileText` into
   `fsw::config` (0:46); S1 gives `follow_sequencer_state`, `find_config_file`,
   `read_file_text`. WP8's `fsw::net` helpers (`openUdpSocket`, `openTcpListener`,
   `serveTcpClients`, `ipv4Destination`) match `bindToDaqInterface`. WP10 §5 mints camelCase
   `registerAllTables` in snake_case `daq_bridge` (0:13) because BLOAT-MAP named it; S1 gives
   `register_all_tables` (a planning name is not an observable). WP9's snake_case in
   `services/calibration` conforms. Decide before WP8 pass 1 (renaming later is a second diff).
3. **What "abstraction" means (S34).** D17(d) read strictly ("no abstraction with a single
   user") would reject WP9's `CalibrationContext`/`StreamState` and WP10's one-call-site cleanup
   extractions (`print_board_routing_table`, `publish_self_tests`, `publish_raw_batch`). STYLE
   adopts WP10's preamble definition; WP9 and WP10 depend on it. Orchestrator to confirm.
4. **Explicit kept behaviour (S12).** WP8 §2.3 has the controller "fall through" on `kListen` and
   §2.2/§4 keep heartbeat's and config_broadcast's ignored `bindToDaqInterface` result implicitly.
   S12 asks WP8's cleanup pass to make the controller's `kListen` an explicit branch marked
   `// Kept: D-CTL (D17)`, and the two ignored binds `// Kept: D-BIND (D17)`. Pass 1 stays as
   written (no added lines).
5. **WP6 §4.3 presents "browser message → log, drop, no reply" as the pattern going forward.**
   S10's direction is one answer per request: a `send_command` whose handler throws (WP6 gap G10)
   would reply `ERROR` to the sender once a golden freezes today's silence and the team approves.
   Suggest relabelling that row "today, kept" so the note does not canonise a defect.
6. **Formatting vs the move-only review rule.** `SortIncludes: true` with `IncludeBlocks: Regroup`
   will reorder the include blocks WP10 §6.1 says to copy "verbatim, pruning nothing" and the ones
   WP9 step 1 adds, and clang-format rewraps code WP6/WP7 move into new indentation. Both notes'
   `--color-moved` rules already allow include lines; reviewers should not treat a reordered include
   block or a rewrapped-but-identical statement as a stop. Worth one sentence in each note.
7. **WP6 M1's wording.** M1 allows top-level constants "from `process.env` or literals"; WP7 §6.1
   S3 puts `const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')` at the
   top of `api/calibration.ts`. Pure, but outside M1's list; S30 adds `import.meta.url`. Amend M1.
8. **BLOAT-MAP is stale against D39.** Its WP rows still say `server/gui-stream-config.ts` and 8
   modules (WP6 has 15 incl. `sensor-stream.ts`), `routes/` and `sensor-config-build.ts` (WP7:
   `api/`, `sensor-config.ts`), `lib/src/calibration/*` and "main < 400" (WP9: `services/calibration/`,
   waived), `UdpSender`/`LineCommandServer`/`SubscriberLoop`/`ServiceMain` (WP8: functions), "8 CMake
   test targets" (WP10: 6 + 4 + the executable). D39 says the orchestrator amends them; not yet done.
   STYLE cites the design notes.
9. **Interim size.** WP10's move-only pass leaves `daq_bridge_main.cpp` at ~835 lines (> S33's
   700); only cleanup brings it under. Fine if the DoD is read per WP, not per pass; say so.
10. **Tooling the brief assumed.** There are no eslint/prettier settings to reference (S40). And
    `daq-server/.pre-commit-config.yaml` pins black 24.1.1 and flake8 at 120 columns, stale against
    D10 (black 25.11.0); not touched here — WP12 or the team.
